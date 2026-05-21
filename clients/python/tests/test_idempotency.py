"""Idempotency key generation tests.

Keep narrow: the goal is to make sure retry semantics work because
the client auto-generates a key when the caller omits one.
"""

import re
import uuid

from doctorchaos_hermes.client import DoctorChaosClient


def test_generates_uuid_when_none_supplied():
    key = DoctorChaosClient._ensure_idempotency_key(None)
    # UUIDv4 shape: 8-4-4-4-12 hex digits.
    assert re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", key)
    # Sanity: it's actually a parseable UUID.
    uuid.UUID(key)


def test_returns_caller_supplied_key_unchanged():
    assert DoctorChaosClient._ensure_idempotency_key("custom-key-123") == "custom-key-123"


def test_treats_empty_string_as_missing():
    # Empty strings should be regenerated; otherwise the client would
    # send an empty key and the daemon would treat it as non-idempotent.
    key = DoctorChaosClient._ensure_idempotency_key("")
    assert key != ""
    uuid.UUID(key)
