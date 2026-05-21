"""doctorchaos-hermes — Python client for the Doctor Chaos HTTP daemon.

This package exposes:

1. ``DoctorChaosClient`` — a thin typed wrapper over the daemon's HTTP
   API. Transport errors surface as Python exceptions; response bodies
   surface as dataclasses.
2. ``DoctorChaosContextEngine`` — a conforming Hermes
   ``ContextEngine`` plugin that delegates routing to the daemon.

Scope note (alpha): the daemon is localhost-only, no auth, single
tenant. This client mirrors that posture — ``tenant_id`` defaults to
``"default"`` and exists in the path only so future multi-tenant
daemon releases can light up without breaking the wire protocol.
"""

from .client import DoctorChaosClient
from .exceptions import (
    BadRequest,
    DaemonConnectionRefused,
    DaemonDnsFailure,
    DaemonServerError,
    DaemonTimeout,
    DaemonUnreachable,
    DoctorChaosError,
    InternalError,
    MessageNotFound,
    SpaceNotFound,
    TenantNotFound,
)
from .plugin import DoctorChaosContextEngine
from .types import (
    Fragment,
    HealthStatus,
    Inbox,
    Message,
    RoutingDecision,
    RoutingDestination,
    SendMessageResult,
    SpaceSummary,
    TopicSpace,
)

__all__ = [
    # Client
    "DoctorChaosClient",
    # Exceptions
    "DoctorChaosError",
    "DaemonUnreachable",
    "DaemonConnectionRefused",
    "DaemonDnsFailure",
    "DaemonTimeout",
    "DaemonServerError",
    "BadRequest",
    "TenantNotFound",
    "SpaceNotFound",
    "MessageNotFound",
    "InternalError",
    # Plugin
    "DoctorChaosContextEngine",
    # Types
    "Message",
    "Fragment",
    "TopicSpace",
    "SpaceSummary",
    "Inbox",
    "RoutingDecision",
    "RoutingDestination",
    "SendMessageResult",
    "HealthStatus",
]

__version__ = "0.1.0a0"
