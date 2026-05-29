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

Route-vs-Compress separation (Req 12, dogfood revision)
-------------------------------------------------------

A1 first cut had ``should_compress`` always return ``True`` so that
``compress`` would fire every turn and could route messages to the
daemon as a side effect. Dogfood found this design hostile when the
daemon was unreachable: Hermes saw "should compress" and ran its own
aggressive built-in compressor on a 1M-token model, even though the
turn was nowhere near the real threshold.

The fix splits the two concerns:

- ``should_compress`` now returns ``True`` only when the daemon is
  reachable AND the prompt actually approaches its budget. Daemon
  down → return ``False`` and let Hermes use its built-in default.
- Routing moves to a background queue. ``_enqueue_new_messages``
  records new turns into ``pending_route_queue``;
  ``_try_flush_queue`` drains the queue opportunistically. Any
  lifecycle hook (``compress``, ``update_from_response``,
  ``on_session_*``) tries to flush; failures stay quiet and the
  queue retains the entries until the daemon comes back.

**Solution A frozen (2026-05-29)**: this file represents the maximum
extent of the in-plugin workaround. The deeper architectural fix —
splitting "context selection" from "context compression" in Hermes's
ContextEngine ABC — requires upstream Hermes changes (Solution B,
tracked as RFC). Solution A is preserved as case-study evidence for
that RFC: it shows what's the best a downstream plugin can do without
ABC changes, and what costs that comes with (routing-vs-reply lag,
recovery burst risk). No further iteration on Solution A while the
RFC track is active.

Design doc: ``design.md`` → "Route-vs-Compress 分离 (Req 12)".
"""

from __future__ import annotations

import hashlib
import logging
import time
from typing import Any, Dict, List, Literal, Mapping, Optional, Set

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

        def should_compress(self, prompt_tokens: int = 0, context_length: int = 0) -> bool:
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

    Routing to the daemon happens in a background queue
    (``pending_route_queue``); Hermes lifecycle hooks opportunistically
    drain the queue. ``compress`` itself only runs when Hermes asked
    for compression based on a real threshold AND the daemon is
    reachable; otherwise it returns the input untouched and lets
    Hermes fall back to its built-in compressor.
    """

    #: Hard cap on the routing queue. When daemon is unreachable for a
    #: long time, oldest entries get dropped (FIFO) so memory doesn't
    #: grow unbounded. 1000 messages is comfortably above any single
    #: dogfood session.
    MAX_QUEUE_SIZE = 1000

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
                ``max_5xx_retries``, ``health_check_interval``.
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
        self.health_check_interval = float(
            config.get("health_check_interval", 30.0)
        )

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

        # Reachability state (Req 8 / Req 12). Public so tests can
        # assert on it.
        self.daemon_state: DaemonState = "reachable"
        self.last_health_check_at: Optional[float] = None

        # Background routing queue (Req 12). Each entry is
        # ``{"role": str, "content": str, "_sig": str}``.
        self.pending_route_queue: List[Dict[str, str]] = []
        self.routed_message_ids: Set[str] = set()

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
        # Opportunistic flush — costs nothing if queue is empty, and
        # if daemon just came back up this is where recovery happens.
        self._try_flush_queue()

    def should_compress(self, prompt_tokens: int = 0, context_length: int = 0) -> bool:
        # Refresh reachability cheaply before answering. Tests can
        # set health_check_interval=0.0 to force a probe every call.
        if self._needs_health_recheck():
            self._run_health_check()

        # Daemon down or degraded → defer to Hermes's built-in
        # compressor. Returning True here when we can't actually
        # produce any space history would just trick Hermes into
        # running its own aggressive compressor on a 1M-token model.
        # This is the dogfood lesson behind Req 12.
        if self.daemon_state in ("unreachable", "degraded"):
            return False

        # Hermes's old single-arg signature passes only prompt_tokens
        # and leaves context_length=0. Without a real budget we can't
        # decide threshold-vs-not, so we return False and let Hermes
        # use its own internal threshold.
        if context_length <= 0:
            return False

        return prompt_tokens >= self.threshold_fraction * context_length

    def compress(
        self,
        messages: List[Mapping[str, Any]],
        current_tokens: int,
        focus_topic: Optional[str] = None,
    ) -> List[Mapping[str, Any]]:
        # Always feed the routing queue — even when we're about to
        # bail with pass-through, queueing is harmless and means new
        # messages land in the daemon as soon as it's reachable again.
        self._enqueue_new_messages(messages)
        self._try_flush_queue()

        # If the daemon was previously down and the health-check
        # window expired, give it a chance to recover here too —
        # otherwise compress can be stuck in pass-through forever
        # when called without should_compress firing first.
        if self.daemon_state != "reachable" and self._needs_health_recheck():
            self._run_health_check()

        # Daemon not reachable → pass-through bottom. Hermes already
        # got told ``should_compress=False`` so this branch is mostly
        # defensive: covers the case where Hermes called compress
        # despite that, or where the daemon dropped between
        # should_compress and compress in the same turn.
        if self.daemon_state != "reachable":
            return list(messages)

        try:
            self._auto_package()
            chosen = self._choose_space(focus_topic)
            if chosen is None:
                # No spaces yet — nothing to surface; pass through.
                self._set_reachable()
                return list(messages)
            full_space = self._fetch_space(chosen.id)
            self._set_reachable()
            return self._compose_output(full_space, messages, current_tokens, focus_topic)
        except DaemonUnreachable as err:
            self._degrade("unreachable", err)
            return list(messages)
        except DaemonServerError as err:
            # Retry-then-degrade (Req 8.2). Exponential backoff. Note
            # that routing has already been handled by the queue; in
            # this retry loop we only re-attempt the read path
            # (choose_space + fetch_space).
            backoff = 0.1
            for _attempt in range(self.max_5xx_retries):
                time.sleep(backoff)
                backoff *= 2
                try:
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
        self._try_flush_queue()

    def on_session_end(self, session_id: str) -> None:
        if self.sub_engine is not None:
            self.sub_engine.on_session_end(session_id)
        self._try_flush_queue()

    def on_session_reset(self, session_id: str) -> None:
        if self.sub_engine is not None:
            self.sub_engine.on_session_reset(session_id)
        self._try_flush_queue()

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

    # ─── Health check (Req 12.6) ────────────────────────────────────

    def _needs_health_recheck(self) -> bool:
        """True if we haven't probed the daemon in ``health_check_interval`` seconds."""
        if self.last_health_check_at is None:
            return True
        return (
            time.monotonic() - self.last_health_check_at
            > self.health_check_interval
        )

    def _run_health_check(self) -> None:
        """Best-effort probe; never lets exceptions escape.

        On success → ``reachable``. On any ``DoctorChaosError`` (which
        covers connection refused, timeout, server error, etc.) →
        ``unreachable``. Either way we stamp ``last_health_check_at``
        so we don't re-probe on every Hermes turn.
        """
        try:
            self.client.health()
            self.daemon_state = "reachable"
        except DoctorChaosError:
            self.daemon_state = "unreachable"
        except Exception:  # noqa: BLE001 — defensive belt-and-braces
            # Anything else (including non-DC errors from a buggy
            # injected client) is treated as unreachable rather than
            # propagating into Hermes's call site.
            self.daemon_state = "unreachable"
        finally:
            self.last_health_check_at = time.monotonic()

    # ─── Routing queue (Req 12.3 / 12.4) ────────────────────────────

    @staticmethod
    def _message_signature(m: Mapping[str, Any]) -> Optional[str]:
        """Return a stable signature for de-duplication, or None if
        the message lacks the role/content shape we can route.

        We prefer a non-empty ``id`` field if present (Hermes some
        times stamps these). Otherwise we hash content + role into a
        16-char prefix; this is enough to distinguish messages within
        a typical session and short enough to keep ``routed_message_ids``
        cheap.
        """
        role = m.get("role")
        content = m.get("content")
        if not isinstance(role, str) or not isinstance(content, str):
            return None
        msg_id = m.get("id")
        if isinstance(msg_id, str) and msg_id:
            return msg_id
        digest = hashlib.sha256(content.encode("utf-8")).hexdigest()[:16]
        return f"{role}:{digest}"

    def _enqueue_new_messages(self, messages: List[Mapping[str, Any]]) -> None:
        """Append newly-seen messages to the routing queue.

        Messages whose signature is already in ``routed_message_ids``
        are skipped — that's how we dedupe across repeated compress
        calls in the same session. We mark messages as routed *at
        enqueue time*, not after a successful daemon ack, so a flush
        failure followed by re-entry doesn't cause double-enqueue.

        Queue cap is enforced after every append: when the queue
        crosses ``MAX_QUEUE_SIZE``, the oldest entry is dropped FIFO.
        """
        if not messages:
            return
        for m in messages:
            sig = self._message_signature(m)
            if sig is None:
                continue
            if sig in self.routed_message_ids:
                continue
            entry: Dict[str, str] = {
                "role": str(m["role"]),
                "content": str(m["content"]),
                "_sig": sig,
            }
            self.pending_route_queue.append(entry)
            self.routed_message_ids.add(sig)
            dropped = 0
            while len(self.pending_route_queue) > self.MAX_QUEUE_SIZE:
                self.pending_route_queue.pop(0)
                dropped += 1
            if dropped > 0:
                _logger.debug(
                    "doctor-chaos: routing queue at cap (%d), "
                    "dropped %d oldest entries.",
                    self.MAX_QUEUE_SIZE,
                    dropped,
                )

    def _try_flush_queue(self, max_per_call: int = 50) -> None:
        """Drain up to ``max_per_call`` messages to the daemon.

        Failures are absorbed silently:

        - ``DaemonUnreachable`` / ``DaemonServerError`` → put the
          current entry back at the head, mark daemon as unreachable
          / degraded, return.
        - Anything else → swallow defensively; the queue is preserved.

        The whole method is wrapped in a try/except so it's safe to
        call from any lifecycle hook without risk of breaking Hermes
        execution.
        """
        try:
            sent_any = False
            for _ in range(max_per_call):
                if not self.pending_route_queue:
                    break
                entry = self.pending_route_queue.pop(0)
                try:
                    self.client.send_message(
                        role=entry["role"],
                        content=entry["content"],
                    )
                    sent_any = True
                except DaemonUnreachable as err:
                    self.pending_route_queue.insert(0, entry)
                    self._degrade("unreachable", err)
                    return
                except DaemonServerError as err:
                    self.pending_route_queue.insert(0, entry)
                    self._degrade("degraded", err)
                    return
            if sent_any:
                # A successful send is proof of reachability; if we
                # were in a down state, this is graceful recovery.
                self._set_reachable()
        except Exception:  # noqa: BLE001 — must never escape
            _logger.debug(
                "doctor-chaos: unexpected error while flushing routing queue.",
                exc_info=True,
            )

    # ─── Topic-space selection ──────────────────────────────────────

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
