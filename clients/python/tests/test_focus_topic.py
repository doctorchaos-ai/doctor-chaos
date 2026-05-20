"""Focus-topic biasing tests (Requirement 7.6)."""

from datetime import datetime, timedelta, timezone
from typing import List

from doctorchaos_hermes import DoctorChaosContextEngine
from doctorchaos_hermes.types import SpaceSummary, TopicSpace, Message


def _space_summary(
    sid: str,
    name: str,
    keywords: List[str],
    minutes_ago: int,
) -> SpaceSummary:
    ts = datetime(2026, 5, 10, tzinfo=timezone.utc) - timedelta(minutes=minutes_ago)
    return SpaceSummary(
        id=sid,
        name=name,
        status="active",
        created_date=ts,
        last_activity_date=ts,
        keywords=keywords,
        message_count=0,
        creation_source="direct",
    )


def _topic_space(sid: str, messages: List[Message]) -> TopicSpace:
    now = datetime(2026, 5, 10, tzinfo=timezone.utc)
    return TopicSpace(
        id=sid,
        name=sid,
        keywords=[],
        created_date=now,
        last_activity_date=now,
        creation_source="direct",
        status="active",
        messages=messages,
    )


class RecordingClient:
    def __init__(self, spaces: List[SpaceSummary]) -> None:
        self.spaces = spaces
        self.fetched_space_ids: List[str] = []

    def send_message(self, **kwargs):
        pass

    def list_spaces(self, status=None):
        return list(self.spaces)

    def get_space(self, space_id: str):
        self.fetched_space_ids.append(space_id)
        return _topic_space(space_id, messages=[])

    def check_packaging(self, **kwargs):
        return []

    def close(self): ...


def test_focus_topic_matches_by_name():
    spaces = [
        _space_summary("recent", "unrelated", [], minutes_ago=1),
        _space_summary("kyoto", "Kyoto trip", ["city"], minutes_ago=60),
        _space_summary("old", "ancient topic", [], minutes_ago=9999),
    ]
    client = RecordingClient(spaces)
    engine = DoctorChaosContextEngine(config={}, client=client)  # type: ignore[arg-type]

    engine.compress([], current_tokens=200, focus_topic="Kyoto")
    assert client.fetched_space_ids == ["kyoto"]


def test_focus_topic_matches_by_keyword():
    spaces = [
        _space_summary("recent", "unrelated", [], minutes_ago=1),
        _space_summary("t1", "topic one", ["paperwork"], minutes_ago=60),
    ]
    client = RecordingClient(spaces)
    engine = DoctorChaosContextEngine(config={}, client=client)  # type: ignore[arg-type]

    engine.compress([], current_tokens=200, focus_topic="paperwork")
    assert client.fetched_space_ids == ["t1"]


def test_no_focus_falls_back_to_most_recent():
    spaces = [
        _space_summary("recent", "n1", [], minutes_ago=1),
        _space_summary("older", "n2", [], minutes_ago=60),
        _space_summary("oldest", "n3", [], minutes_ago=600),
    ]
    client = RecordingClient(spaces)
    engine = DoctorChaosContextEngine(config={}, client=client)  # type: ignore[arg-type]

    engine.compress([], current_tokens=200)
    assert client.fetched_space_ids == ["recent"]


def test_focus_with_no_match_falls_back_to_recency():
    spaces = [
        _space_summary("recent", "unrelated", [], minutes_ago=1),
        _space_summary("older", "still unrelated", [], minutes_ago=60),
    ]
    client = RecordingClient(spaces)
    engine = DoctorChaosContextEngine(config={}, client=client)  # type: ignore[arg-type]

    engine.compress([], current_tokens=200, focus_topic="nothing-matches")
    assert client.fetched_space_ids == ["recent"]


def test_no_spaces_returns_passthrough():
    client = RecordingClient(spaces=[])
    engine = DoctorChaosContextEngine(config={}, client=client)  # type: ignore[arg-type]

    msgs = [{"role": "user", "content": "hi"}]
    out = engine.compress(list(msgs), current_tokens=200, focus_topic="anything")
    assert out == msgs
    assert client.fetched_space_ids == []
