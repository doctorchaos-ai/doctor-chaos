"""Hermes plugin entry point for Doctor Chaos.

This file must live at:
  ~/.hermes/plugins/doctor-chaos/__init__.py

Hermes's plugin loader scans ~/.hermes/plugins/ for direct
subdirectories, finds __init__.py in each, and calls register(ctx).

The actual plugin logic lives in the `doctorchaos_hermes` package
(installed via pip). This file is just the bridge that tells Hermes
"here's my ContextEngine instance, please use it".
"""

from __future__ import annotations

import os
from typing import Any


def register(ctx: Any) -> None:
    """Called by Hermes plugin loader on startup.

    Reads config from environment variables and Hermes config.yaml,
    instantiates the DoctorChaosContextEngine, and registers it.
    """
    from doctorchaos_hermes.plugin import DoctorChaosContextEngine

    # Build config from environment + sensible defaults.
    # Users can override via Hermes config.yaml's doctor_chaos section,
    # but the plugin loader doesn't pass that to us directly — we read
    # env vars as the primary config surface (same as the daemon).
    config = {
        "base_url": os.environ.get(
            "DOCTOR_CHAOS_URL", "http://127.0.0.1:18790"
        ),
        "tenant_id": os.environ.get("DOCTOR_CHAOS_TENANT_ID", "default"),
        "timeout": float(os.environ.get("DOCTOR_CHAOS_TIMEOUT", "120")),
        "compression_threshold_fraction": 0.75,
        "max_5xx_retries": 2,
        "sub_engine": os.environ.get("DOCTOR_CHAOS_SUB_ENGINE") or None,
    }

    engine = DoctorChaosContextEngine(config=config)
    ctx.register_context_engine(engine)
