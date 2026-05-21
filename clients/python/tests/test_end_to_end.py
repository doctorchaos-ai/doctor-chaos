"""End-to-end test against a real daemon subprocess.

Starts ``node dist/cli.cjs start --port <random>`` in a subprocess,
polls ``/v1/health`` until it's up, then runs a CRUD loop through
the Python client. Tears the subprocess down in ``finally``.

Skipped if ``node`` or the built daemon isn't available — this keeps
the test suite runnable on machines without a Node toolchain while
still giving us real-wire coverage on dev machines.
"""

from __future__ import annotations

import os
import random
import shutil
import socket
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Optional

import httpx
import pytest

from doctorchaos_hermes import DoctorChaosClient


REPO_ROOT = Path(__file__).resolve().parents[3]
CLI_CJS = REPO_ROOT / "packages" / "server" / "dist" / "cli.cjs"


def _node_available() -> bool:
    return shutil.which("node") is not None


def _daemon_built() -> bool:
    return CLI_CJS.exists()


def _random_port() -> int:
    return 41000 + random.randint(0, 999)


def _wait_for_health(port: int, timeout_s: float = 10.0) -> None:
    deadline = time.time() + timeout_s
    last_err: Optional[Exception] = None
    while time.time() < deadline:
        try:
            with httpx.Client(timeout=0.5) as c:
                r = c.get(f"http://127.0.0.1:{port}/v1/health")
                if r.status_code == 200:
                    return
        except Exception as err:  # noqa: BLE001 - deliberately broad in bootstrap poll
            last_err = err
        time.sleep(0.1)
    raise RuntimeError(
        f"Daemon on port {port} did not become healthy within {timeout_s}s: {last_err}"
    )


@pytest.mark.skipif(not _node_available(), reason="node not on PATH")
@pytest.mark.skipif(
    not _daemon_built(),
    reason="Daemon bundle missing; run 'pnpm --filter @doctorchaos-ai/server build' first.",
)
def test_end_to_end_crud_loop(tmp_path: Path):
    port = _random_port()
    snapshot_path = tmp_path / "snapshot.json"
    proc = subprocess.Popen(
        [
            "node",
            str(CLI_CJS),
            "start",
            "--port",
            str(port),
            "--snapshot",
            str(snapshot_path),
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        cwd=str(REPO_ROOT),
    )
    try:
        _wait_for_health(port)
        with DoctorChaosClient(base_url=f"http://127.0.0.1:{port}") as client:
            # send
            send = client.send_message(role="user", content="end-to-end test")
            # read
            if send.destination == "topicSpace":
                assert send.space is not None
                fetched = client.get_space(send.space.id)
                assert fetched.id == send.space.id
                assert fetched.messages[0].content == "end-to-end test"
            spaces = client.list_spaces()
            # inbox always reachable even if empty
            inbox = client.get_inbox()
            assert inbox is not None
            # idempotent write endpoints are a no-op on a fresh clinic
            assert client.check_packaging() == []
            assert client.check_lifecycle() == []
            # sanity: health works through the client too
            health = client.health()
            assert health.status == "ok"
            # just make sure list_spaces didn't return nonsense
            assert isinstance(spaces, list)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)
