"""Plugin ABC conformance and basic happy-path tests."""

import inspect

from doctorchaos_hermes import DoctorChaosContextEngine


def test_name_is_doctor_chaos(monkeypatch):
    # Avoid constructing a real client — the constructor doesn't
    # hit the network, but we pin an explicit config anyway.
    class FakeClient:
        def close(self): ...

    engine = DoctorChaosContextEngine(
        config={"base_url": "http://127.0.0.1:18790"},
        client=FakeClient(),  # type: ignore[arg-type]
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
    class FakeClient:
        def close(self): ...

    engine = DoctorChaosContextEngine(
        config={}, client=FakeClient(),  # type: ignore[arg-type]
    )
    engine.update_from_response({
        "prompt_tokens": 1200,
        "completion_tokens": 300,
        "total_tokens": 1500,
    })
    assert engine.last_prompt_tokens == 1200
    assert engine.last_completion_tokens == 300
    assert engine.last_total_tokens == 1500


def test_should_compress_always_returns_true():
    class FakeClient:
        def close(self): ...

    engine = DoctorChaosContextEngine(
        config={"compression_threshold_fraction": 0.5},
        client=FakeClient(),  # type: ignore[arg-type]
    )
    # Doctor Chaos always returns True because it needs compress()
    # called on every turn to route messages, regardless of token count.
    assert engine.should_compress(600, 1000) is True
    assert engine.should_compress(400, 1000) is True
    assert engine.should_compress(100, 0) is True
    assert engine.should_compress(0, 1000000) is True
