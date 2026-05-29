"""Route-vs-Compress separation tests (Requirement 12).

Covers four scenarios:

1. Daemon up throughout — every distinct message reaches the daemon
   exactly once.
2. Daemon goes down mid-stream — pass-through, message stays in
   queue, ``daemon_state`` reflects unreachable.
3. Daemon recovers — queued messages flush without duplicating any
   already-routed entries.
4. Queue cap — feed more than ``MAX_QUEUE_SIZE`` and assert oldest
   are dropped.
"""

from datetime import datetime, timezone
from typing import List, Optional

from doctorchaos_hermes import DoctorChaosContextEngine
from doctorchaos_hermes.exceptions import (
    DaemonConnectionRefused,
    DaemonServerError,
)
from doctorchaos_hermes.types import (
    HealthStatus,
    Message,
    SpaceSummary,
    TopicSpace,
)


# ─── Helpers ────────────────────────────────────────────────────────

def _summary(space_id: str = "s1", name: str = "Default") -> SpaceSummary:
    now = datetime(2026, 5, 28, tzinfo=timezone.utc)
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


def _space(space_id: str = "s1", messages: Optional[List[Message]] = None) -> TopicSpace:
    now = datetime(2026, 5, 28, tzinfo=timezone.utc)
    return TopicSpace(
        id=space_id,
        name="Default",
        keywords=[],
        created_date=now,
        last_activity_date=now,
        creation_source="direct",
        status="active",
        messages=messages or [],
    )


class SwitchableClient:
    """Fake client whose mode toggles between ``up`` and ``down``."""

    def __init__(self) -> None:
        self.mode = "up"
        self.sent_messages: List[dict] = []

    def health(self):
        if self.mode == "down":
            raise DaemonConnectionRefused("down")
        return HealthStatus(status="ok", version="0.1.0a1")

    def send_message(self, **kwargs):
        if self.mode == "down":
            raise DaemonConnectionRefused("down")
        self.sent_messages.append(kwargs)

    def list_spaces(self, status=None):
        if self.mode == "down":
            raise DaemonConnectionRefused("down")
        return [_summary()]

    def get_space(self, space_id: str):
        if self.mode == "down":
            raise DaemonConnectionRefused("down")
        return _space(space_id)

    def check_packaging(self, **kwargs):
        if self.mode == "down":
            raise DaemonConnectionRefused("down")
        return []

    def close(self): ...


# ─── Scenario 1: daemon up throughout ───────────────────────────────

def test_daemon_up_throughout_routes_each_message_once(monkeypatch):
    monkeypatch.setattr("doctorchaos_hermes.plugin.time.sleep", lambda _s: None)
    client = SwitchableClient()
    engine = DoctorChaosContextEngine(
        config={"health_check_interval": 0.0},
        client=client,  # type: ignore[arg-type]
    )

    m1 = {"role": "user", "content": "first message"}
    m2 = {"role": "assistant", "content": "second message"}
    m3 = {"role": "user", "content": "third message"}

    # Three compress calls with the message list growing, mimicking
    # how Hermes accumulates a turn's history.
    engine.compress([m1], current_tokens=100)
    engine.compress([m1, m2], current_tokens=100)
    engine.compress([m1, m2, m3], current_tokens=100)

    # Each unique message routed exactly once.
    contents = [m["content"] for m in client.sent_messages]
    assert contents == ["first message", "second message", "third message"]
    # Queue empty at the end of the run.
    assert engine.pending_route_queue == []
    assert engine.daemon_state == "reachable"


# ─── Scenario 2: daemon goes down mid-stream ────────────────────────

def test_daemon_goes_down_keeps_message_in_queue(monkeypatch):
    monkeypatch.setattr("doctorchaos_hermes.plugin.time.sleep", lambda _s: None)
    client = SwitchableClient()
    engine = DoctorChaosContextEngine(
        config={"health_check_interval": 0.0},
        client=client,  # type: ignore[arg-type]
    )

    # Phase 1: daemon up — three messages routed.
    m1 = {"role": "user", "content": "alpha"}
    m2 = {"role": "user", "content": "beta"}
    m3 = {"role": "user", "content": "gamma"}
    engine.compress([m1, m2, m3], current_tokens=100)
    assert len(client.sent_messages) == 3

    # Phase 2: daemon flips down. New compress call should fall back
    # to pass-through and keep m4 in the queue.
    client.mode = "down"
    m4 = {"role": "user", "content": "delta"}
    out = engine.compress([m1, m2, m3, m4], current_tokens=100)

    # Pass-through: returns the original messages.
    assert out == [m1, m2, m3, m4]
    # m4 is queued, waiting for daemon recovery.
    queued_contents = [e["content"] for e in engine.pending_route_queue]
    assert "delta" in queued_contents
    # Already-routed messages don't re-enter the queue.
    assert "alpha" not in queued_contents
    assert engine.daemon_state == "unreachable"


# ─── Scenario 3: daemon recovers, queue drains, no duplicates ───────

def test_daemon_recovers_queue_drains_without_duplicates(monkeypatch):
    monkeypatch.setattr("doctorchaos_hermes.plugin.time.sleep", lambda _s: None)
    client = SwitchableClient()
    engine = DoctorChaosContextEngine(
        config={"health_check_interval": 0.0},
        client=client,  # type: ignore[arg-type]
    )

    # Phase 1: daemon up — three messages routed.
    m1 = {"role": "user", "content": "alpha"}
    m2 = {"role": "user", "content": "beta"}
    m3 = {"role": "user", "content": "gamma"}
    engine.compress([m1, m2, m3], current_tokens=100)
    assert len(client.sent_messages) == 3

    # Phase 2: daemon down. m4 queues up.
    client.mode = "down"
    m4 = {"role": "user", "content": "delta"}
    engine.compress([m1, m2, m3, m4], current_tokens=100)
    assert engine.daemon_state == "unreachable"
    # m4 in queue, m1-m3 already routed and deduped.
    assert any(e["content"] == "delta" for e in engine.pending_route_queue)

    # Phase 3: daemon recovers. New turn brings m5 along with m4.
    client.mode = "up"
    m5 = {"role": "user", "content": "epsilon"}
    engine.compress([m1, m2, m3, m4, m5], current_tokens=100)

    # Both m4 and m5 reached the daemon.
    contents = [m["content"] for m in client.sent_messages]
    assert contents.count("delta") == 1
    assert contents.count("epsilon") == 1
    # No duplicates of m1-m3 — they were deduped at enqueue time.
    assert contents.count("alpha") == 1
    assert contents.count("beta") == 1
    assert contents.count("gamma") == 1
    # Queue drained.
    assert engine.pending_route_queue == []
    assert engine.daemon_state == "reachable"


# ─── Scenario 4: queue cap of 1000 ──────────────────────────────────

def test_queue_cap_drops_oldest_fifo(monkeypatch):
    monkeypatch.setattr("doctorchaos_hermes.plugin.time.sleep", lambda _s: None)
    client = SwitchableClient()
    client.mode = "down"  # daemon down for the entire test
    engine = DoctorChaosContextEngine(
        config={"health_check_interval": 0.0},
        client=client,  # type: ignore[arg-type]
    )

    # Feed 1500 unique messages.
    big_batch = [
        {"role": "user", "content": f"msg-{i:04d}"} for i in range(1500)
    ]
    engine.compress(big_batch, current_tokens=100)

    # Queue capped at 1000.
    assert len(engine.pending_route_queue) == DoctorChaosContextEngine.MAX_QUEUE_SIZE
    assert len(engine.pending_route_queue) == 1000
    # Oldest 500 dropped: queue should hold msg-0500 .. msg-1499.
    queued_contents = [e["content"] for e in engine.pending_route_queue]
    assert queued_contents[0] == "msg-0500"
    assert queued_contents[-1] == "msg-1499"
    assert "msg-0000" not in queued_contents
    assert "msg-0499" not in queued_contents
