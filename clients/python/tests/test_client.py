"""Client method tests using pytest-httpx to mock the daemon.

Each test asserts both directions:
- the request we send (method, path, body)
- the response we parse into a typed dataclass

We keep the fixtures as plain dicts shaped like the real wire format
so a future daemon wire-format drift would break these immediately.
"""

from datetime import datetime, timezone

import httpx
import pytest

from doctorchaos_hermes import (
    DaemonConnectionRefused,
    DaemonTimeout,
    DoctorChaosClient,
    SpaceNotFound,
)


# ─── Fixtures ────────────────────────────────────────────────────────

def fake_space() -> dict:
    return {
        "id": "s1",
        "name": "Kyoto trip",
        "keywords": ["kyoto", "trip"],
        "createdDate": "2026-05-01T00:00:00.000Z",
        "lastActivityDate": "2026-05-10T08:00:00.000Z",
        "creationSource": "direct",
        "status": "active",
        "messages": [
            {
                "id": "m1",
                "role": "user",
                "content": "hi",
                "timestamp": "2026-05-01T00:00:00.000Z",
            }
        ],
    }


def fake_send_topic_response(space: dict) -> dict:
    return {
        "destination": "topicSpace",
        "space": space,
        "isNewSpace": True,
        "message": space["messages"][0],
        "decision": {
            "destination": {
                "kind": "newTopicSpace",
                "suggestedName": space["name"],
            },
            "confidence": 0.6,
            "reasoning": "Test fixture.",
        },
    }


# ─── Health ──────────────────────────────────────────────────────────

def test_health(httpx_mock):
    httpx_mock.add_response(
        url="http://127.0.0.1:18790/v1/health",
        json={"status": "ok", "version": "0.1.0-alpha.0"},
    )
    with DoctorChaosClient() as client:
        health = client.health()
    assert health.status == "ok"
    assert health.version == "0.1.0-alpha.0"


# ─── send_message ────────────────────────────────────────────────────

def test_send_message_happy_path(httpx_mock):
    httpx_mock.add_response(
        url="http://127.0.0.1:18790/v1/tenants/default/messages",
        method="POST",
        json=fake_send_topic_response(fake_space()),
    )
    with DoctorChaosClient() as client:
        result = client.send_message(role="user", content="hi")
    assert result.destination == "topicSpace"
    assert result.space is not None
    assert result.space.name == "Kyoto trip"
    assert result.space.created_date == datetime(2026, 5, 1, 0, 0, tzinfo=timezone.utc)


def test_send_message_includes_idempotency_key_when_absent(httpx_mock):
    httpx_mock.add_response(
        url="http://127.0.0.1:18790/v1/tenants/default/messages",
        method="POST",
        json=fake_send_topic_response(fake_space()),
    )
    with DoctorChaosClient() as client:
        client.send_message(role="user", content="hi")
    # pytest-httpx exposes every recorded request; the last one is ours.
    recorded = httpx_mock.get_request()
    import json

    body = json.loads(recorded.content.decode("utf-8"))
    assert "idempotency_key" in body
    assert body["idempotency_key"]


def test_send_message_maps_404_space_not_found(httpx_mock):
    # send_message doesn't normally 404 on space, but this verifies
    # that _request translates a 404 body into the correct exception
    # class regardless of which method triggered it.
    httpx_mock.add_response(
        url="http://127.0.0.1:18790/v1/tenants/default/spaces/nope",
        status_code=404,
        json={
            "code": "space_not_found",
            "message": "Space 'nope' not found.",
            "request_id": "req-abc",
        },
    )
    with DoctorChaosClient() as client, pytest.raises(SpaceNotFound) as err:
        client.get_space("nope")
    assert err.value.request_id == "req-abc"


# ─── list_spaces ─────────────────────────────────────────────────────

def test_list_spaces_passes_status_filter(httpx_mock):
    httpx_mock.add_response(
        url="http://127.0.0.1:18790/v1/tenants/default/spaces?status=active%2Carchived",
        json={
            "spaces": [
                {
                    "id": "s1",
                    "name": "n",
                    "status": "active",
                    "createdDate": "2026-05-01T00:00:00.000Z",
                    "lastActivityDate": "2026-05-10T00:00:00.000Z",
                    "keywords": [],
                    "messageCount": 0,
                    "creationSource": "direct",
                }
            ]
        },
    )
    with DoctorChaosClient() as client:
        spaces = client.list_spaces(status=["active", "archived"])
    assert len(spaces) == 1
    assert spaces[0].id == "s1"


# ─── get_inbox ───────────────────────────────────────────────────────

def test_get_inbox_empty(httpx_mock):
    httpx_mock.add_response(
        url="http://127.0.0.1:18790/v1/tenants/default/inbox",
        json={"id": "inbox", "fragments": [], "totalMessageCount": 0},
    )
    with DoctorChaosClient() as client:
        inbox = client.get_inbox()
    assert inbox.total_message_count == 0
    assert inbox.fragments == []


# ─── check_packaging / check_lifecycle ───────────────────────────────

def test_check_packaging_empty(httpx_mock):
    httpx_mock.add_response(
        url="http://127.0.0.1:18790/v1/tenants/default/packaging/check",
        method="POST",
        json={"createdSpaces": []},
    )
    with DoctorChaosClient() as client:
        assert client.check_packaging() == []


def test_check_lifecycle_empty(httpx_mock):
    httpx_mock.add_response(
        url="http://127.0.0.1:18790/v1/tenants/default/lifecycle/check",
        method="POST",
        json={"changedSpaces": []},
    )
    with DoctorChaosClient() as client:
        assert client.check_lifecycle() == []


# ─── move_message ────────────────────────────────────────────────────

def test_move_message_returns_updated_target(httpx_mock):
    httpx_mock.add_response(
        url="http://127.0.0.1:18790/v1/tenants/default/messages/m1/move",
        method="POST",
        json=fake_space(),
    )
    with DoctorChaosClient() as client:
        updated = client.move_message("m1", "s1")
    assert updated.id == "s1"


# ─── Transport failures ──────────────────────────────────────────────

def test_connection_refused_raises_daemon_connection_refused(httpx_mock):
    httpx_mock.add_exception(
        httpx.ConnectError("Connection refused", request=httpx.Request("GET", "http://x")),
    )
    with DoctorChaosClient() as client, pytest.raises(DaemonConnectionRefused):
        client.health()


def test_timeout_raises_daemon_timeout(httpx_mock):
    httpx_mock.add_exception(
        httpx.ReadTimeout("Request timed out.", request=httpx.Request("GET", "http://x")),
    )
    with DoctorChaosClient() as client, pytest.raises(DaemonTimeout):
        client.health()
