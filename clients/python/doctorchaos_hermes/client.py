"""Thin HTTP client for the Doctor Chaos daemon.

Design principles:

1. **One method per daemon endpoint.** No clever "retry forever" or
   "pool across tenants" behaviour — callers that want those can
   build them on top.

2. **Typed responses.** Every method returns a dataclass from
   ``doctorchaos_hermes.types``. The client is the only place that
   knows about wire-format dicts; callers see Pythonic shapes.

3. **Typed exceptions.** Transport failures, 4xx, and 5xx each raise
   a distinct subclass of ``DoctorChaosError``. Callers never have
   to parse HTTP status codes themselves.

4. **Idempotency key defaults.** Write methods auto-generate a
   UUIDv4 key when none is provided, so naive ``try / retry`` logic
   is safe.
"""

from __future__ import annotations

import uuid
from types import TracebackType
from typing import Any, List, Mapping, Optional, Type, Union

import httpx

from .exceptions import (
    DaemonConnectionRefused,
    DaemonDnsFailure,
    DaemonServerError,
    DaemonTimeout,
    DaemonUnreachable,
    DoctorChaosError,
    raise_for_error_body,
)
from .types import (
    CheckResponse,
    HealthStatus,
    Inbox,
    SendMessageResult,
    SpaceSummary,
    TopicSpace,
)

DEFAULT_BASE_URL = "http://127.0.0.1:18790"
DEFAULT_TENANT_ID = "default"
DEFAULT_TIMEOUT_SECONDS = 10.0


class DoctorChaosClient:
    """Synchronous HTTP client for the Doctor Chaos daemon.

    Example::

        with DoctorChaosClient() as client:
            result = client.send_message(role="user", content="hi")
            if result.destination == "topicSpace":
                space = client.get_space(result.space.id)

    Threading / concurrency: instances own an ``httpx.Client`` and
    should not be shared across threads without external locking.
    Create one client per thread, or close and reopen.
    """

    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        tenant_id: str = DEFAULT_TENANT_ID,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.tenant_id = tenant_id
        self._client = httpx.Client(timeout=timeout)

    # ─── Context manager ────────────────────────────────────────────

    def __enter__(self) -> "DoctorChaosClient":
        return self

    def __exit__(
        self,
        exc_type: Optional[Type[BaseException]],
        exc: Optional[BaseException],
        tb: Optional[TracebackType],
    ) -> None:
        self.close()

    def close(self) -> None:
        """Release the underlying HTTP connection pool.

        Safe to call multiple times.
        """
        self._client.close()

    # ─── Endpoint methods ───────────────────────────────────────────

    def health(self) -> HealthStatus:
        body = self._request("GET", "/v1/health")
        return HealthStatus.from_dict(body)

    def send_message(
        self,
        role: str,
        content: str,
        message_id: Optional[str] = None,
        timestamp: Optional[str] = None,
        idempotency_key: Optional[str] = None,
    ) -> SendMessageResult:
        body = {"role": role, "content": content}
        if message_id is not None:
            body["id"] = message_id
        if timestamp is not None:
            body["timestamp"] = timestamp
        body["idempotency_key"] = self._ensure_idempotency_key(idempotency_key)
        raw = self._request(
            "POST",
            self._tenant_path("messages"),
            json_body=body,
        )
        return SendMessageResult.from_dict(raw)

    def list_spaces(self, status: Optional[List[str]] = None) -> List[SpaceSummary]:
        params: Optional[Mapping[str, str]] = None
        if status:
            params = {"status": ",".join(status)}
        raw = self._request(
            "GET",
            self._tenant_path("spaces"),
            params=params,
        )
        if not isinstance(raw, dict):
            raise DoctorChaosError("Expected object with 'spaces' key.")
        spaces = raw.get("spaces", [])
        if not isinstance(spaces, list):
            raise DoctorChaosError("Response 'spaces' is not a list.")
        return [SpaceSummary.from_dict(s) for s in spaces]

    def get_space(self, space_id: str) -> TopicSpace:
        raw = self._request(
            "GET",
            self._tenant_path(f"spaces/{space_id}"),
        )
        return TopicSpace.from_dict(raw)

    def get_inbox(self) -> Inbox:
        raw = self._request(
            "GET",
            self._tenant_path("inbox"),
        )
        return Inbox.from_dict(raw)

    def check_packaging(self, idempotency_key: Optional[str] = None) -> CheckResponse:
        raw = self._request(
            "POST",
            self._tenant_path("packaging/check"),
            json_body={"idempotency_key": self._ensure_idempotency_key(idempotency_key)},
        )
        if not isinstance(raw, dict):
            raise DoctorChaosError("Expected object with 'createdSpaces' key.")
        created = raw.get("createdSpaces", [])
        if not isinstance(created, list):
            raise DoctorChaosError("Response 'createdSpaces' is not a list.")
        return [TopicSpace.from_dict(s) for s in created]

    def check_lifecycle(self, idempotency_key: Optional[str] = None) -> CheckResponse:
        raw = self._request(
            "POST",
            self._tenant_path("lifecycle/check"),
            json_body={"idempotency_key": self._ensure_idempotency_key(idempotency_key)},
        )
        if not isinstance(raw, dict):
            raise DoctorChaosError("Expected object with 'changedSpaces' key.")
        changed = raw.get("changedSpaces", [])
        if not isinstance(changed, list):
            raise DoctorChaosError("Response 'changedSpaces' is not a list.")
        return [TopicSpace.from_dict(s) for s in changed]

    def move_message(
        self,
        message_id: str,
        to_space_id: str,
        idempotency_key: Optional[str] = None,
    ) -> TopicSpace:
        raw = self._request(
            "POST",
            self._tenant_path(f"messages/{message_id}/move"),
            json_body={
                "to_space_id": to_space_id,
                "idempotency_key": self._ensure_idempotency_key(idempotency_key),
            },
        )
        return TopicSpace.from_dict(raw)

    # ─── Internals ──────────────────────────────────────────────────

    def _tenant_path(self, suffix: str) -> str:
        return f"/v1/tenants/{self.tenant_id}/{suffix}"

    @staticmethod
    def _ensure_idempotency_key(caller_supplied: Optional[str]) -> str:
        if caller_supplied is not None and caller_supplied != "":
            return caller_supplied
        return str(uuid.uuid4())

    def _request(
        self,
        method: str,
        path: str,
        *,
        json_body: Optional[Mapping[str, Any]] = None,
        params: Optional[Mapping[str, str]] = None,
    ) -> Any:
        url = f"{self.base_url}{path}"
        try:
            response = self._client.request(
                method,
                url,
                json=json_body,
                params=params,
            )
        except httpx.ConnectError as err:
            # httpx wraps "connection refused" and "DNS failure" into
            # the same class; sniff the underlying cause message to
            # split them. The message shapes are stable enough for a
            # sanity split; future httpx versions that reshape these
            # will still get a ``DaemonUnreachable`` which is the
            # thing callers actually branch on.
            cause_msg = str(err)
            lower = cause_msg.lower()
            if "refused" in lower or "econnrefused" in lower:
                raise DaemonConnectionRefused(
                    f"Daemon at {url} refused the connection. "
                    f"Is 'doctor-chaos-server start' running?"
                ) from err
            if "resolve" in lower or "name or service not known" in lower or "nodename" in lower:
                raise DaemonDnsFailure(
                    f"Could not resolve host for {url}: {cause_msg}"
                ) from err
            raise DaemonUnreachable(f"Daemon at {url} is unreachable: {cause_msg}") from err
        except httpx.TimeoutException as err:
            raise DaemonTimeout(f"Request to {url} timed out.") from err

        request_id = response.headers.get("X-Request-Id")

        # 2xx: parse JSON and return.
        if 200 <= response.status_code < 300:
            try:
                return response.json()
            except ValueError as err:
                raise DoctorChaosError(
                    f"Daemon returned status {response.status_code} with non-JSON body.",
                    request_id=request_id,
                ) from err

        # Non-2xx: translate into the right exception.
        try:
            error_body: Union[dict, list, str, int, float, None] = response.json()
        except ValueError:
            error_body = None
        if error_body is None:
            if response.status_code >= 500:
                raise DaemonServerError(
                    f"Daemon returned status {response.status_code} with non-JSON body.",
                    status_code=response.status_code,
                    request_id=request_id,
                )
            raise DoctorChaosError(
                f"Daemon returned status {response.status_code} with non-JSON body.",
                request_id=request_id,
            )
        raise_for_error_body(
            response.status_code, error_body, default_request_id=request_id
        )
        # raise_for_error_body always raises; this return is for type-checkers.
        return None  # pragma: no cover
