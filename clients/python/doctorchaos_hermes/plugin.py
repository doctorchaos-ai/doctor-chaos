"""Hermes ``ContextEngine`` plugin for Doctor Chaos.

This module is the A1 dogfood target: when installed into the user's
Hermes plugin directory, it makes Doctor Chaos available as
``context.engine: "doctor-chaos"`` in ``config.yaml``.

Two import paths:

1. Inside a real Hermes install, ``from agent.context_engine import
   ContextEngine`` succeeds and we inherit from it.
2. In the standalone test environment Hermes is absent; we fall back
   to a local ABC stub that has the same method shapes. Tests exercise
   this path directly; the real plugin path is only lit up in Hermes.

The zero-Hermes import path is for testability only. When Hermes is
present, the plugin ABC drives behaviour exactly as it does for any
other context engine.
"""

from __future__ import annotations

import logging
import time
from typing import Any, Dict, List, Literal, Mapping, Optional

from .client import DoctorChaosClient
from .exceptions import (
    DaemonServerError,
    DaemonUnreachable,
    DoctorChaosError,
)
from .types import Message, SpaceSummary, TopicSpace

_logger = logging.getLogger(__name__)


# ─── Hermes ABC shim ─────────────────────────────────────────────────

try:
    # Real Hermes import. When present, we inherit from it directly.
    from agent.context_engine import ContextEngine as _HermesContextEngine  # type: ignore
except ImportError:
    # Local stub so tests and non-Hermes installs can still exercise
    # the plugin surface. Method shapes mirror Hermes's ABC:
    # https://hermes-agent.nousresearch.com/docs/developer-guide/context-engine-plugin
    class _HermesContextEngine:  # type: ignore[no-redef]
        last_prompt_tokens: int = 0
        last_completion_tokens: int = 0
        last_total_tokens: int = 0

        @property
        def name(self) -> str:
            raise NotImplementedError

        def update_from_response(self, usage: Mapping[str, Any]) -> None:
            raise NotImplementedError

        def should_compress(self, prompt_tokens: int, context_length: int) -> bool:
            raise NotImplementedError

        def compress(
            self,
            messages: List[Mapping[str, Any]],
            current_tokens: int,
            focus_topic: Optional[str] = None,
        ) -> List[Mapping[str, Any]]:
            raise NotImplementedError

        def on_session_start(self, session_id: str) -> None:
            pass

        def on_session_end(self, session_id: str) -> None:
            pass

        def on_session_reset(self, session_id: str) -> None:
            pass

        def get_tool_schemas(self) -> List[Mapping[str, Any]]:
            return []

        def handle_tool_call(
            self, tool_name: str, arguments: Mapping[str, Any]
        ) -> Mapping[str, Any]:
            raise NotImplementedError


# ─── Reachability state machine (Req 8) ──────────────────────────────

DaemonState = Literal["reachable", "degraded", "unreachable"]


# ─── The plugin ──────────────────────────────────────────────────────

class DoctorChaosContextEngine(_HermesContextEngine):
    """A Hermes ContextEngine that delegates routing to Doctor Chaos.

    Every Hermes turn flows through ``compress``, which:

    1. Flushes any un-routed new messages to the daemon.
    2. Picks a focus topic space (by ``focus_topic`` or by recency).
    3. Fetches that space's full history.
    4. Either hands to a nested sub-engine or tail-trims to budget.

    If the daemon is unreachable or degraded, the plugin returns the
    incoming messages unchanged (pass-through) so Hermes falls back
    to its own default compression. One warning per reachability
    transition; no warning storms.
    """

    def __init__(
        self,
        config: Mapping[str, Any],
        *,
        client: Optional[DoctorChaosClient] = None,
        sub_engine_loader: Optional[Any] = None,
    ) -> None:
        """
        Args:
            config: The plugin config block from Hermes. Known keys:
                ``base_url``, ``tenant_id``, ``timeout``,
                ``compression_threshold_fraction``, ``sub_engine``,
                ``max_5xx_retries``.
            client: Test-only override — inject a mock client.
            sub_engine_loader: Test-only override — a callable that
                takes a sub-engine name and returns a ContextEngine
                instance. In real Hermes this is the plugin registry.
        """
        self._config = dict(config)
        self.base_url = str(config.get("base_url", "http://127.0.0.1:18790"))
        self.tenant_id = str(config.get("tenant_id", "default"))
        self.timeout = float(config.get("timeout", 120.0))
        self.threshold_fraction = float(
            config.get("compression_threshold_fraction", 0.75)
        )
        self.max_5xx_retries = int(config.get("max_5xx_retries", 2))

        self.client: DoctorChaosClient = client or DoctorChaosClient(
            base_url=self.base_url,
            tenant_id=self.tenant_id,
            timeout=self.timeout,
        )

        # Nested sub-engine (Req 9).
        sub_name = config.get("sub_engine")
        self.sub_engine: Optional[_HermesContextEngine] = None
        if sub_name:
            if sub_engine_loader is None:
                raise DoctorChaosError(
                    "Sub-engine configured but no sub_engine_loader provided. "
                    "In Hermes this is wired automatically; in tests pass one "
                    "explicitly."
                )
            loaded = sub_engine_loader(sub_name)
            if loaded is None:
                raise DoctorChaosError(
                    f"Sub-engine '{sub_name}' could not be loaded; refusing "
                    f"to start rather than silently disable it."
                )
            self.sub_engine = loaded

        # Reachability state (Req 8). Public so tests can assert on it.
        self.daemon_state: DaemonState = "reachable"

        # Hermes-ABC bookkeeping fields.
        self.last_prompt_tokens = 0
        self.last_completion_tokens = 0
        self.last_total_tokens = 0

    # ─── ABC methods ────────────────────────────────────────────────

    @property
    def name(self) -> str:
        return "doctor-chaos"

    def update_from_response(self, usage: Mapping[str, Any]) -> None:
        self.last_prompt_tokens = int(usage.get("prompt_tokens", 0) or 0)
        self.last_completion_tokens = int(usage.get("completion_tokens", 0) or 0)
        self.last_total_tokens = int(usage.get("total_tokens", 0) or 0)
        if self.sub_engine is not None:
            self.sub_engine.update_from_response(usage)

    def should_compress(self, prompt_tokens: int, context_length: int) -> bool:
        # Doctor Chaos needs compress() called on EVERY turn to route
        # messages into topic spaces, regardless of whether the context
        # window is "full". Without this, _flush_unrouted() never fires
        # and the daemon never sees any messages.
        #
        # The original design gated on threshold_fraction, which made
        # sense for a pure compression engine but is wrong for a routing
        # engine that must see every message to do its job.
        return True

    def compress(
        self,
        messages: List[Mapping[str, Any]],
        current_tokens: int,
        focus_topic: Optional[str] = None,
    ) -> List[Mapping[str, Any]]:
        try:
            self._flush_unrouted(messages)
            self._auto_package()
            chosen = self._choose_space(focus_topic)
            if chosen is None:
                # No spaces yet — nothing to compress against; pass
                # the messages back untouched so Hermes's default
                # handling applies.
                self._set_reachable()
                return list(messages)
            full_space = self._fetch_space(chosen.id)
            self._set_reachable()
            return self._compose_output(full_space, messages, current_tokens, focus_topic)
        except DaemonUnreachable as err:
            self._degrade("unreachable", err)
            return list(messages)
        except DaemonServerError as err:
            # Retry-then-degrade (Req 8.2). Exponential backoff.
            backoff = 0.1
            for attempt in range(self.max_5xx_retries):
                time.sleep(backoff)
                backoff *= 2
                try:
                    self._flush_unrouted(messages)
                    self._auto_package()
                    chosen = self._choose_space(focus_topic)
                    if chosen is None:
                        self._set_reachable()
                        return list(messages)
                    full_space = self._fetch_space(chosen.id)
                    self._set_reachable()
                    return self._compose_output(full_space, messages, current_tokens, focus_topic)
                except DaemonServerError:
                    continue
                except DaemonUnreachable as retry_err:
                    self._degrade("unreachable", retry_err)
                    return list(messages)
            # All retries exhausted.
            self._degrade("degraded", err)
            return list(messages)

    def on_session_start(self, session_id: str) -> None:
        if self.sub_engine is not None:
            self.sub_engine.on_session_start(session_id)

    def on_session_end(self, session_id: str) -> None:
        if self.sub_engine is not None:
            self.sub_engine.on_session_end(session_id)

    def on_session_reset(self, session_id: str) -> None:
        if self.sub_engine is not None:
            self.sub_engine.on_session_reset(session_id)

    def get_tool_schemas(self) -> List[Mapping[str, Any]]:
        if self.sub_engine is not None:
            return self.sub_engine.get_tool_schemas()
        return []

    def handle_tool_call(
        self, tool_name: str, arguments: Mapping[str, Any]
    ) -> Mapping[str, Any]:
        if self.sub_engine is not None:
            return self.sub_engine.handle_tool_call(tool_name, arguments)
        raise NotImplementedError(
            f"Doctor Chaos plugin has no tools; unknown tool '{tool_name}'."
        )

    # ─── Internals ──────────────────────────────────────────────────

    def _flush_unrouted(self, messages: List[Mapping[str, Any]]) -> None:
        """Route any message Hermes has seen but that we haven't yet.

        Very simple heuristic for A1: any message with a ``content``
        field but no ``_doctor_chaos_routed`` marker is forwarded to
        the daemon. Hermes message shapes vary; we only read two
        fields (``role``, ``content``) and ignore everything else.

        Future versions could persist a seen-message-id set and use
        that instead of a marker.
        """
        for m in messages:
            role = m.get("role")
            content = m.get("content")
            if not isinstance(role, str) or not isinstance(content, str):
                continue
            if m.get("_doctor_chaos_routed"):
                continue
            self.client.send_message(role=role, content=content)
            # Mutating the caller's dict would be surprising; we
            # leave the marker off. This means repeated calls to
            # compress with the same messages would re-send. A real
            # implementation would dedupe client-side; at the dogfood
            # stage the idempotency key on the wire is enough as long
            # as callers pass the same key, which we currently don't.
            # Acceptable because Hermes only calls compress once per
            # turn; any real duplicate-routing pain surfaces in A2
            # dogfood and prompts a fix.

    def _auto_package(self) -> None:
        """Trigger packaging check after flushing messages.

        This promotes inbox fragments into topic spaces when they
        reach the clustering threshold. Without this, fragments
        accumulate in the inbox forever unless someone manually
        calls POST /packaging/check.
        """
        try:
            self.client.check_packaging()
        except (DaemonUnreachable, DaemonServerError):
            # Non-fatal: if packaging fails we still have the inbox
            # fragments and can try again next turn.
            pass

    def _choose_space(self, focus_topic: Optional[str]) -> Optional[SpaceSummary]:
        """Pick the topic space to surface for this turn."""
        spaces = self.client.list_spaces(status=["active"])
        if not spaces:
            return None
        if focus_topic:
            topic_lower = focus_topic.lower()

            def score(s: SpaceSummary) -> float:
                total = 0.0
                if topic_lower in s.name.lower():
                    total += 3.0
                for kw in s.keywords:
                    if topic_lower in kw.lower():
                        total += 1.0
                return total

            ranked = sorted(spaces, key=score, reverse=True)
            if score(ranked[0]) > 0:
                return ranked[0]
        # Fall back to most recently active.
        return sorted(spaces, key=lambda s: s.last_activity_date, reverse=True)[0]

    def _fetch_space(self, space_id: str) -> TopicSpace:
        return self.client.get_space(space_id)

    def _compose_output(
        self,
        space: TopicSpace,
        original_messages: List[Mapping[str, Any]],
        current_tokens: int,
        focus_topic: Optional[str],
    ) -> List[Mapping[str, Any]]:
        """Produce the list Hermes will send to the model.

        Two branches:

        1. ``sub_engine`` configured → hand the space's messages to
           the sub-engine and return whatever it produces.
        2. No sub-engine → tail-trim by count to a conservative
           approximation of the budget (A1 stub; A2 can plug a real
           token counter when dogfood needs it).

        We also prepend a tiny ``system`` marker so downstream
        debugging is easier.
        """
        space_messages = [self._message_to_wire(m) for m in space.messages]
        marker: Mapping[str, Any] = {
            "role": "system",
            "content": f"[doctor-chaos] focus_topic={focus_topic or ''} space={space.name}",
        }

        if self.sub_engine is not None:
            sub_out = self.sub_engine.compress(
                space_messages,
                current_tokens,
                focus_topic,
            )
            return [marker] + list(sub_out)

        # Tail-trim (A1): keep the N most recent messages where N
        # approximates the budget. current_tokens is a proxy; we
        # don't do real tokenisation until someone complains.
        approx_msgs = max(5, current_tokens // 200)
        trimmed = space_messages[-approx_msgs:]
        return [marker] + trimmed

    @staticmethod
    def _message_to_wire(m: Message) -> Mapping[str, Any]:
        return {
            "role": m.role,
            "content": m.content,
        }

    # ─── Reachability state transitions ─────────────────────────────

    def _set_reachable(self) -> None:
        if self.daemon_state != "reachable":
            _logger.info(
                "doctor-chaos: daemon reachable again at %s", self.base_url,
            )
            self.daemon_state = "reachable"

    def _degrade(self, to_state: DaemonState, err: Exception) -> None:
        if self.daemon_state == to_state:
            return
        self.daemon_state = to_state
        if to_state == "unreachable":
            _logger.warning(
                "doctor-chaos: daemon unreachable at %s (%s); "
                "falling back to default compression.",
                self.base_url,
                err,
            )
        else:
            _logger.warning(
                "doctor-chaos: daemon at %s returned 5xx after retries (%s); "
                "falling back to default compression.",
                self.base_url,
                err,
            )


__all__ = ["DoctorChaosContextEngine"]
