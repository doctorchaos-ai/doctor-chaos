"""Typed data classes mirroring the daemon's JSON response shapes.

Each ``from_dict`` classmethod parses a ``dict`` (JSON-decoded
payload) into a fully-typed Python value. Time fields come in as ISO
strings over the wire and get parsed to ``datetime`` here once.

Python 3.9 compatibility note: we stick to ``List[...]``, ``Dict[...]``,
``Optional[...]`` from ``typing`` rather than PEP 604 ``X | Y`` syntax,
so the package installs and runs on the macOS system Python.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Literal, Mapping, Optional, Union


# ─── Helpers ─────────────────────────────────────────────────────────

def _parse_iso(value: Any, context: str) -> datetime:
    if not isinstance(value, str):
        raise ValueError(f"{context}: expected ISO 8601 string, got {type(value).__name__}.")
    # ``datetime.fromisoformat`` on 3.9 doesn't accept a trailing 'Z';
    # the daemon emits "...Z" (via JS ``toISOString``), so we normalise.
    normalised = value
    if normalised.endswith("Z"):
        normalised = normalised[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(normalised)
    except ValueError as err:
        raise ValueError(f"{context}: invalid ISO 8601 date '{value}': {err}") from err
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def _require(mapping: Mapping[str, Any], key: str, context: str) -> Any:
    if key not in mapping:
        raise ValueError(f"{context}: missing required field '{key}'.")
    return mapping[key]


# ─── Plain response shapes ──────────────────────────────────────────

@dataclass(frozen=True)
class HealthStatus:
    status: str
    version: str

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> "HealthStatus":
        return cls(
            status=str(_require(raw, "status", "HealthStatus")),
            version=str(_require(raw, "version", "HealthStatus")),
        )


@dataclass(frozen=True)
class RoutingMetadata:
    original_destination: str
    confidence: float
    was_reassigned: bool
    reassigned_from: Optional[str] = None

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> "RoutingMetadata":
        return cls(
            original_destination=str(_require(raw, "originalDestination", "RoutingMetadata")),
            confidence=float(_require(raw, "confidence", "RoutingMetadata")),
            was_reassigned=bool(raw.get("wasReassigned", False)),
            reassigned_from=raw.get("reassignedFrom"),
        )


@dataclass(frozen=True)
class Message:
    id: str
    role: str
    content: str
    timestamp: datetime
    routing: Optional[RoutingMetadata] = None

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> "Message":
        routing_raw = raw.get("routing")
        return cls(
            id=str(_require(raw, "id", "Message")),
            role=str(_require(raw, "role", "Message")),
            content=str(_require(raw, "content", "Message")),
            timestamp=_parse_iso(_require(raw, "timestamp", "Message"), "Message.timestamp"),
            routing=RoutingMetadata.from_dict(routing_raw) if isinstance(routing_raw, Mapping) else None,
        )


@dataclass(frozen=True)
class Fragment:
    id: str
    messages: List[Message]
    timestamp: datetime
    keywords: List[str]
    cluster_hint: Optional[str] = None

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> "Fragment":
        msgs_raw = _require(raw, "messages", "Fragment")
        kws_raw = _require(raw, "keywords", "Fragment")
        if not isinstance(msgs_raw, list):
            raise ValueError("Fragment.messages: expected list.")
        if not isinstance(kws_raw, list):
            raise ValueError("Fragment.keywords: expected list.")
        return cls(
            id=str(_require(raw, "id", "Fragment")),
            messages=[Message.from_dict(m) for m in msgs_raw],
            timestamp=_parse_iso(_require(raw, "timestamp", "Fragment"), "Fragment.timestamp"),
            keywords=[str(k) for k in kws_raw],
            cluster_hint=raw.get("clusterHint"),
        )


@dataclass(frozen=True)
class TopicSpace:
    id: str
    name: str
    keywords: List[str]
    created_date: datetime
    last_activity_date: datetime
    creation_source: str
    status: str
    messages: List[Message]
    context_summary: Optional[str] = None

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> "TopicSpace":
        kws_raw = _require(raw, "keywords", "TopicSpace")
        msgs_raw = _require(raw, "messages", "TopicSpace")
        if not isinstance(kws_raw, list):
            raise ValueError("TopicSpace.keywords: expected list.")
        if not isinstance(msgs_raw, list):
            raise ValueError("TopicSpace.messages: expected list.")
        return cls(
            id=str(_require(raw, "id", "TopicSpace")),
            name=str(_require(raw, "name", "TopicSpace")),
            keywords=[str(k) for k in kws_raw],
            created_date=_parse_iso(
                _require(raw, "createdDate", "TopicSpace"), "TopicSpace.createdDate"
            ),
            last_activity_date=_parse_iso(
                _require(raw, "lastActivityDate", "TopicSpace"),
                "TopicSpace.lastActivityDate",
            ),
            creation_source=str(_require(raw, "creationSource", "TopicSpace")),
            status=str(_require(raw, "status", "TopicSpace")),
            messages=[Message.from_dict(m) for m in msgs_raw],
            context_summary=raw.get("contextSummary"),
        )


@dataclass(frozen=True)
class SpaceSummary:
    id: str
    name: str
    status: str
    created_date: datetime
    last_activity_date: datetime
    keywords: List[str]
    message_count: int
    creation_source: str

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> "SpaceSummary":
        kws_raw = _require(raw, "keywords", "SpaceSummary")
        if not isinstance(kws_raw, list):
            raise ValueError("SpaceSummary.keywords: expected list.")
        return cls(
            id=str(_require(raw, "id", "SpaceSummary")),
            name=str(_require(raw, "name", "SpaceSummary")),
            status=str(_require(raw, "status", "SpaceSummary")),
            created_date=_parse_iso(
                _require(raw, "createdDate", "SpaceSummary"), "SpaceSummary.createdDate"
            ),
            last_activity_date=_parse_iso(
                _require(raw, "lastActivityDate", "SpaceSummary"),
                "SpaceSummary.lastActivityDate",
            ),
            keywords=[str(k) for k in kws_raw],
            message_count=int(_require(raw, "messageCount", "SpaceSummary")),
            creation_source=str(_require(raw, "creationSource", "SpaceSummary")),
        )


@dataclass(frozen=True)
class Inbox:
    id: str
    fragments: List[Fragment]
    total_message_count: int

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> "Inbox":
        frags_raw = _require(raw, "fragments", "Inbox")
        if not isinstance(frags_raw, list):
            raise ValueError("Inbox.fragments: expected list.")
        return cls(
            id=str(_require(raw, "id", "Inbox")),
            fragments=[Fragment.from_dict(f) for f in frags_raw],
            total_message_count=int(_require(raw, "totalMessageCount", "Inbox")),
        )


# ─── Routing decision ───────────────────────────────────────────────

RoutingKind = Literal["existingTopicSpace", "newTopicSpace", "inbox"]


@dataclass(frozen=True)
class RoutingDestination:
    kind: RoutingKind
    topic_space_id: Optional[str] = None
    suggested_name: Optional[str] = None

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> "RoutingDestination":
        kind = str(_require(raw, "kind", "RoutingDestination"))
        if kind not in ("existingTopicSpace", "newTopicSpace", "inbox"):
            raise ValueError(f"RoutingDestination.kind: unknown kind '{kind}'.")
        return cls(
            kind=kind,  # type: ignore[arg-type]
            topic_space_id=raw.get("topicSpaceId"),
            suggested_name=raw.get("suggestedName"),
        )


@dataclass(frozen=True)
class RoutingDecision:
    destination: RoutingDestination
    confidence: float
    reasoning: str

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> "RoutingDecision":
        dest_raw = _require(raw, "destination", "RoutingDecision")
        if not isinstance(dest_raw, Mapping):
            raise ValueError("RoutingDecision.destination: expected object.")
        return cls(
            destination=RoutingDestination.from_dict(dest_raw),
            confidence=float(_require(raw, "confidence", "RoutingDecision")),
            reasoning=str(_require(raw, "reasoning", "RoutingDecision")),
        )


# ─── Send-message result (discriminated union) ──────────────────────

@dataclass(frozen=True)
class SendMessageResult:
    """Result of ``DoctorChaosClient.send_message``.

    The ``destination`` field is the discriminator; exactly one of
    ``space`` / ``inbox`` + ``fragment`` is populated depending on
    which branch the daemon took.
    """

    destination: Literal["topicSpace", "inbox"]
    message: Message
    decision: RoutingDecision
    # Present when destination == "topicSpace"
    space: Optional[TopicSpace] = None
    is_new_space: Optional[bool] = None
    # Present when destination == "inbox"
    inbox: Optional[Inbox] = None
    fragment: Optional[Fragment] = None

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> "SendMessageResult":
        destination = str(_require(raw, "destination", "SendMessageResult"))
        message = Message.from_dict(_require(raw, "message", "SendMessageResult"))
        decision = RoutingDecision.from_dict(
            _require(raw, "decision", "SendMessageResult")
        )
        if destination == "topicSpace":
            return cls(
                destination="topicSpace",
                message=message,
                decision=decision,
                space=TopicSpace.from_dict(_require(raw, "space", "SendMessageResult")),
                is_new_space=bool(_require(raw, "isNewSpace", "SendMessageResult")),
            )
        if destination == "inbox":
            return cls(
                destination="inbox",
                message=message,
                decision=decision,
                inbox=Inbox.from_dict(_require(raw, "inbox", "SendMessageResult")),
                fragment=Fragment.from_dict(_require(raw, "fragment", "SendMessageResult")),
            )
        raise ValueError(f"SendMessageResult.destination: unknown '{destination}'.")


# ─── Convenience aliases ────────────────────────────────────────────

SpacesResponse = List[SpaceSummary]
CheckResponse = List[TopicSpace]

__all__ = [
    "HealthStatus",
    "Message",
    "RoutingMetadata",
    "Fragment",
    "TopicSpace",
    "SpaceSummary",
    "Inbox",
    "RoutingDestination",
    "RoutingDecision",
    "RoutingKind",
    "SendMessageResult",
    "SpacesResponse",
    "CheckResponse",
]
