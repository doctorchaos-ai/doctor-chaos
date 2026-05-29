"""Plugin ABC conformance and basic happy-path tests."""

from datetime import datetime, timezone

from doctorchaos_hermes import DoctorChaosContextEngine
from doctorchaos_hermes.exceptions import DaemonConnectionRefused
from doctorchaos_hermes.types import HealthStatus


# ─── Test fakes ──────────────────────────────────────────────────────

class _StubClient:
    """Bare-minimum fake client for ABC-shape assertions.

    ``health`` succeeds by default; tests that need an unreachable
    client can override or use ``_UnreachableHealthClient``.
    """

    def __init__(self) -> None:
        self.health_calls = 0

    def health(self):
        self.health_calls += 1
        return HealthStatus(status="ok", version="0.1.0a1")

    def send_message(self, **kwargs):
        return None

    def list_spaces(self, status=None):
        return []

    def get_space(self, space_id):
        raise NotImplementedError

    def check_packaging(self, **kwargs):
        return []

    def close(self):
        pass


class _UnreachableHealthClient(_StubClient):
    """Health probe blows up — used to test the daemon-down branch."""

    def health(self):
        raise DaemonConnectionRefused("daemon down")


# ─── Tests ───────────────────────────────────────────────────────────

def test_name_is_doctor_chaos():
    engine = DoctorChaosContextEngine(
        config={"base_url": "http://127.0.0.1:18790"},
        client=_StubClient(),  # type: ignore[arg-type]
    )
    assert engine.name == "doctor-chaos"


def test_has_all_required_abc_methods():
    # Presence check rather than strict signature check (Hermes ABC
    # may grow optional kwargs over time; we match the shapes
    # documented in the plugin doc).
    required = [
        "name",
        "update_from_response",
        "should_compress",
        "compress",
        "on_session_start",
        "on_session_end",
        "on_session_reset",
        "get_tool_schemas",
        "handle_tool_call",
    ]
    for member in required:
        attr = getattr(DoctorChaosContextEngine, member, None)
        assert attr is not None, f"missing ABC method: {member}"


def test_update_from_response_sets_token_counters():
    engine = DoctorChaosContextEngine(
        config={}, client=_StubClient(),  # type: ignore[arg-type]
    )
    engine.update_from_response({
        "prompt_tokens": 1200,
        "completion_tokens": 300,
        "total_tokens": 1500,
    })
    assert engine.last_prompt_tokens == 1200
    assert engine.last_completion_tokens == 300
    assert engine.last_total_tokens == 1500


# ─── should_compress (Req 12) ────────────────────────────────────────

def test_should_compress_unreachable_returns_false():
    """Daemon unreachable → defer to Hermes built-in (Req 12.1)."""
    engine = DoctorChaosContextEngine(
        config={"compression_threshold_fraction": 0.5},
        client=_UnreachableHealthClient(),  # type: ignore[arg-type]
    )
    # Even with prompt_tokens way over threshold, we return False so
    # Hermes falls back to its own (smarter) compression decision.
    assert engine.should_compress(999_999, 1_000_000) is False
    assert engine.daemon_state == "unreachable"


def test_should_compress_reachable_under_threshold():
    """Daemon reachable, prompt below threshold → False (Req 12.2)."""
    engine = DoctorChaosContextEngine(
        config={"compression_threshold_fraction": 0.5},
        client=_StubClient(),  # type: ignore[arg-type]
    )
    assert engine.should_compress(400, 1000) is False


def test_should_compress_reachable_at_threshold():
    """Daemon reachable, prompt at/over threshold → True (Req 12.2)."""
    engine = DoctorChaosContextEngine(
        config={"compression_threshold_fraction": 0.5},
        client=_StubClient(),  # type: ignore[arg-type]
    )
    assert engine.should_compress(500, 1000) is True
    assert engine.should_compress(600, 1000) is True


def test_should_compress_no_context_length_returns_false():
    """Old single-arg signature (context_length=0) → False (Req 12.7).

    Without a real budget we can't decide threshold; let Hermes use
    its built-in default.
    """
    engine = DoctorChaosContextEngine(
        config={"compression_threshold_fraction": 0.5},
        client=_StubClient(),  # type: ignore[arg-type]
    )
    assert engine.should_compress(999_999, 0) is False
    # default-arg form (Hermes ContextCompressor old signature)
    assert engine.should_compress(999_999) is False
