"""Degradation and recovery tests (Requirements 8.1 / 8.3 / 8.5 / 12)."""

import logging
from datetime import datetime, timezone
from typing import List, Optional

import pytest

from doctorchaos_hermes import DoctorChaosContextEngine
from doctorchaos_hermes.exceptions import DaemonConnectionRefused, DaemonServerError
from doctorchaos_hermes.types import HealthStatus, SpaceSummary, TopicSpace, Message


def make_space_summary(space_id: str = "s1", name: str = "n") -> SpaceSummary:
    now = datetime(2026, 5, 10, tzinfo=timezone.utc)
    return SpaceSummary(
        id=space_id,
        name=name,
        status="active",
        created_date=now,
        last_activity_date=now,
        keywords=[],
        message_count=0,
        creation_source="direct",
    )


def make_topic_space(
    space_id: str = "s1", messages: Optional[List[Message]] = None
) -> TopicSpace:
    now = datetime(2026, 5, 10, tzinfo=timezone.utc)
    return TopicSpace(
        id=space_id,
        name="n",
        keywords=[],
        created_date=now,
        last_activity_date=now,
        creation_source="direct",
        status="active",
        messages=messages or [],
    )


# ─── Test client fakes ──────────────────────────────────────────────

class UnreachableClient:
    """Every method raises DaemonConnectionRefused, including health."""

    def health(self):
        raise DaemonConnectionRefused("boom")

    def send_message(self, **kwargs):
        raise DaemonConnectionRefused("boom")

    def list_spaces(self, status=None):
        raise DaemonConnectionRefused("boom")

    def get_space(self, space_id: str):
        raise DaemonConnectionRefused("boom")

    def check_packaging(self, **kwargs):
        raise DaemonConnectionRefused("boom")

    def close(self): ...


class FlakyClient:
    """Fails a configured number of times with 5xx before succeeding.

    ``health`` always succeeds — this fake represents a daemon that
    accepts the health probe but mis-handles list_spaces.
    """

    def __init__(self, fail_count: int) -> None:
        self.fail_count = fail_count
        self.sent_messages: List[dict] = []
        self.list_calls = 0
        self.get_calls = 0

    def health(self):
        return HealthStatus(status="ok", version="0.1.0a1")

    def send_message(self, **kwargs):
        self.sent_messages.append(kwargs)
        return None

    def list_spaces(self, status=None):
        self.list_calls += 1
        if self.list_calls <= self.fail_count:
            raise DaemonServerError("oops", status_code=503)
        return [make_space_summary()]

    def get_space(self, space_id: str):
        self.get_calls += 1
        return make_topic_space(space_id)

    def check_packaging(self, **kwargs):
        return []

    def close(self): ...


class HappyClient:
    def __init__(self, spaces: List[SpaceSummary]) -> None:
        self.spaces = spaces
        self.full = {s.id: make_topic_space(s.id) for s in spaces}
        self.sent: List[dict] = []

    def health(self):
        return HealthStatus(status="ok", version="0.1.0a1")

    def send_message(self, **kwargs):
        self.sent.append(kwargs)

    def list_spaces(self, status=None):
        return list(self.spaces)

    def get_space(self, space_id: str):
        return self.full[space_id]

    def check_packaging(self, **kwargs):
        return []

    def close(self): ...


# ─── Tests ──────────────────────────────────────────────────────────

def test_unreachable_returns_messages_passthrough(caplog):
    engine = DoctorChaosContextEngine(
        config={"health_check_interval": 0.0},
        client=UnreachableClient(),  # type: ignore[arg-type]
    )
    original = [{"role": "user", "content": "hi"}]
    with caplog.at_level(logging.WARNING, logger="doctorchaos_hermes.plugin"):
        out = engine.compress(list(original), current_tokens=500)
    assert out == original
    assert engine.daemon_state == "unreachable"
    # Req 8.1: warning present.
    assert any("unreachable" in rec.message.lower() for rec in caplog.records)
    # Req 12.1: should_compress now reflects daemon-down → False.
    assert engine.should_compress(0, 1000) is False


def test_unreachable_warns_only_once_per_window(caplog):
    engine = DoctorChaosContextEngine(
        config={"health_check_interval": 0.0},
        client=UnreachableClient(),  # type: ignore[arg-type]
    )
    with caplog.at_level(logging.WARNING, logger="doctorchaos_hermes.plugin"):
        engine.compress([], current_tokens=100)
        engine.compress([], current_tokens=100)
        engine.compress([], current_tokens=100)
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    # Exactly one warning across three unreachable turns.
    assert len(warnings) == 1


def test_recovers_silently_on_next_success(caplog):
    """daemon_state goes unreachable → reachable without log spam."""
    happy = HappyClient(spaces=[make_space_summary()])

    class SwitchableClient:
        def __init__(self) -> None:
            self.mode = "bad"

        def health(self):
            if self.mode == "bad":
                raise DaemonConnectionRefused("down")
            return HealthStatus(status="ok", version="0.1.0a1")

        def send_message(self, **kwargs):
            if self.mode == "bad":
                raise DaemonConnectionRefused("down")
            happy.send_message(**kwargs)

        def list_spaces(self, status=None):
            if self.mode == "bad":
                raise DaemonConnectionRefused("down")
            return happy.list_spaces(status=status)

        def get_space(self, space_id: str):
            if self.mode == "bad":
                raise DaemonConnectionRefused("down")
            return happy.get_space(space_id)

        def check_packaging(self, **kwargs):
            if self.mode == "bad":
                raise DaemonConnectionRefused("down")
            return []

        def close(self): ...

    client = SwitchableClient()
    engine = DoctorChaosContextEngine(
        # Force a probe on every should_compress / lifecycle path.
        config={"health_check_interval": 0.0},
        client=client,  # type: ignore[arg-type]
    )
    with caplog.at_level(logging.WARNING, logger="doctorchaos_hermes.plugin"):
        engine.compress([], current_tokens=100)  # unreachable
        client.mode = "good"
        # update_from_response opportunistically flushes the queue and
        # picks up reachability via a successful send. compress runs
        # afterwards and confirms the recovered state.
        engine.update_from_response({"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0})
        engine.compress([], current_tokens=100)
    assert engine.daemon_state == "reachable"
    # Req 8.3: recovery is silent — no additional WARN lines after
    # the first degrade warning.
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 1


def test_retries_5xx_then_succeeds(monkeypatch):
    # Keep retry backoff negligible so the test is fast.
    monkeypatch.setattr("doctorchaos_hermes.plugin.time.sleep", lambda _s: None)
    flaky = FlakyClient(fail_count=1)
    engine = DoctorChaosContextEngine(
        config={"max_5xx_retries": 2, "health_check_interval": 0.0},
        client=flaky,  # type: ignore[arg-type]
    )
    out = engine.compress([], current_tokens=100)
    # list_spaces was called twice (one 5xx, one success).
    assert flaky.list_calls == 2
    assert engine.daemon_state == "reachable"
    assert isinstance(out, list)


def test_5xx_all_retries_exhausted_degrades(monkeypatch, caplog):
    monkeypatch.setattr("doctorchaos_hermes.plugin.time.sleep", lambda _s: None)
    flaky = FlakyClient(fail_count=99)  # never succeeds
    engine = DoctorChaosContextEngine(
        config={"max_5xx_retries": 2, "health_check_interval": 0.0},
        client=flaky,  # type: ignore[arg-type]
    )
    with caplog.at_level(logging.WARNING, logger="doctorchaos_hermes.plugin"):
        out = engine.compress(
            [{"role": "user", "content": "hi"}], current_tokens=100
        )
    assert out == [{"role": "user", "content": "hi"}]
    assert engine.daemon_state == "degraded"
    # One initial attempt + 2 retries == 3 total calls.
    assert flaky.list_calls == 3
