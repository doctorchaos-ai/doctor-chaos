"""Typed exception hierarchy for the Doctor Chaos Python client.

Every 4xx response from the daemon maps to a specific subclass keyed
off the ``code`` field in the error body. Transport failures (daemon
unreachable, timeout) get their own branch so callers can distinguish
"daemon is sick" from "the request was wrong".

All exceptions carry an optional ``request_id`` attribute so users
can copy-paste it into a bug report without fishing through logs.
"""

from __future__ import annotations

from typing import Dict, Optional, Type


class DoctorChaosError(Exception):
    """Base class for every Doctor Chaos client error.

    Catch this to treat any failure uniformly. Most code should catch
    a narrower subclass.
    """

    def __init__(self, message: str, *, request_id: Optional[str] = None) -> None:
        super().__init__(message)
        self.message = message
        self.request_id = request_id

    def __str__(self) -> str:  # pragma: no cover - trivial
        if self.request_id:
            return f"{self.message} (request_id={self.request_id})"
        return self.message


# ─── Transport errors ────────────────────────────────────────────────

class DaemonUnreachable(DoctorChaosError):
    """Raised when the daemon cannot be reached at the configured URL.

    Prefer the more specific subclasses when identifying the root
    cause matters (e.g. logs distinguishing network-down from daemon-
    not-running).
    """


class DaemonConnectionRefused(DaemonUnreachable):
    """The daemon's host is reachable but nothing is listening on the port.

    Typical cause: the daemon hasn't been started, or it crashed.
    """


class DaemonDnsFailure(DaemonUnreachable):
    """The configured hostname could not be resolved.

    Rare for localhost configs but possible when a user puts a real
    hostname in ``base_url``.
    """


class DaemonTimeout(DoctorChaosError):
    """Request took longer than the configured timeout.

    By contract, raising this means no local state was mutated (the
    request either didn't reach the daemon or the daemon didn't
    respond in time).
    """


class DaemonServerError(DoctorChaosError):
    """The daemon returned a 5xx response.

    Distinct from 4xx: client-side callers can retry a 5xx (usually
    with backoff), while 4xx indicates the request itself was wrong.
    """

    def __init__(
        self,
        message: str,
        *,
        status_code: int,
        request_id: Optional[str] = None,
    ) -> None:
        super().__init__(message, request_id=request_id)
        self.status_code = status_code


# ─── 4xx error code → exception mapping ──────────────────────────────

class BadRequest(DoctorChaosError):
    """400 — request validation failed (missing fields, bad types, etc.)."""


class TenantNotFound(DoctorChaosError):
    """404 — the requested tenant_id doesn't exist.

    In the current build the only valid tenant is ``default``; any
    other value triggers this.
    """


class SpaceNotFound(DoctorChaosError):
    """404 — the referenced topic space id is not present in the tenant."""


class MessageNotFound(DoctorChaosError):
    """404 — the referenced message id is not present anywhere in the tenant."""


class InternalError(DoctorChaosError):
    """500 — the daemon hit an uncaught exception.

    The message field is sanitised — server-side logs carry the real
    stack trace, keyed by the ``request_id`` on this exception.
    """


# ─── The code → class map the client uses ────────────────────────────

#: Order matters only for documentation. ``.get(code, DoctorChaosError)``
#: is the lookup semantics.
ERROR_CODE_MAP: Dict[str, Type[DoctorChaosError]] = {
    "bad_request": BadRequest,
    "tenant_not_found": TenantNotFound,
    "space_not_found": SpaceNotFound,
    "message_not_found": MessageNotFound,
    "internal_error": InternalError,
}


def raise_for_error_body(
    status_code: int,
    body: object,
    *,
    default_request_id: Optional[str] = None,
) -> None:
    """Translate a daemon error body into the right Python exception.

    ``body`` should be the JSON-decoded payload of the error response.
    If it doesn't look like a Doctor Chaos error body (wrong shape,
    missing ``code``) we fall back to ``DoctorChaosError`` with a
    synthetic message.

    Called by the client's ``_request`` helper; kept as a free
    function so tests can exercise it without instantiating a client.
    """
    if not isinstance(body, dict):
        raise DoctorChaosError(
            f"Daemon returned status {status_code} with non-object body.",
            request_id=default_request_id,
        )
    code = body.get("code")
    message = body.get("message") or f"Daemon returned status {status_code}."
    request_id = body.get("request_id") or default_request_id

    if status_code >= 500:
        raise DaemonServerError(
            str(message), status_code=status_code, request_id=request_id
        )
    # 4xx: map by code.
    exc_cls = ERROR_CODE_MAP.get(str(code), DoctorChaosError) if code else DoctorChaosError
    raise exc_cls(str(message), request_id=request_id)
