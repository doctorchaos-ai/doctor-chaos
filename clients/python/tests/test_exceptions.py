"""Exception mapping tests — no HTTP, just the pure code→class path."""

import pytest

from doctorchaos_hermes.exceptions import (
    BadRequest,
    DaemonServerError,
    DoctorChaosError,
    MessageNotFound,
    SpaceNotFound,
    TenantNotFound,
    raise_for_error_body,
)


@pytest.mark.parametrize(
    "status, code, exc_cls",
    [
        (400, "bad_request", BadRequest),
        (404, "tenant_not_found", TenantNotFound),
        (404, "space_not_found", SpaceNotFound),
        (404, "message_not_found", MessageNotFound),
    ],
)
def test_maps_error_code_to_class(status, code, exc_cls):
    body = {"code": code, "message": "m", "request_id": "req-x"}
    with pytest.raises(exc_cls) as err:
        raise_for_error_body(status, body)
    assert err.value.message == "m"
    assert err.value.request_id == "req-x"


def test_500_internal_error_raises_daemon_server_error():
    # 5xx always surfaces as DaemonServerError so callers can
    # distinguish "daemon is sick, retry later" from "your 4xx
    # request was wrong, don't retry". The InternalError class stays
    # for future non-500 internal issues; the daemon's current
    # internal_error path is a 500 so this is the right split.
    body = {"code": "internal_error", "message": "boom", "request_id": "req-y"}
    with pytest.raises(DaemonServerError) as err:
        raise_for_error_body(500, body)
    assert err.value.status_code == 500
    assert err.value.request_id == "req-y"


def test_5xx_raises_daemon_server_error_regardless_of_code():
    body = {"code": "unknown_code", "message": "boom", "request_id": "req-y"}
    with pytest.raises(DaemonServerError) as err:
        raise_for_error_body(503, body)
    assert err.value.status_code == 503
    assert err.value.request_id == "req-y"


def test_unknown_4xx_code_falls_back_to_base_error():
    body = {"code": "weird_code", "message": "eh", "request_id": "req-z"}
    with pytest.raises(DoctorChaosError) as err:
        raise_for_error_body(418, body)
    # Should be the base class, not a more specific subclass.
    assert type(err.value) is DoctorChaosError
    assert err.value.request_id == "req-z"


def test_non_object_body_falls_back():
    with pytest.raises(DoctorChaosError) as err:
        raise_for_error_body(400, "not a dict", default_request_id="req-k")
    assert err.value.request_id == "req-k"
    assert "400" in err.value.message


def test_missing_code_falls_back_to_base_class():
    body = {"message": "nameless", "request_id": "req-m"}
    with pytest.raises(DoctorChaosError) as err:
        raise_for_error_body(400, body)
    assert type(err.value) is DoctorChaosError
    assert err.value.message == "nameless"
