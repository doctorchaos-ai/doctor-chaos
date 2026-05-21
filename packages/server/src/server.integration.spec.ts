import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from './server.js';
import type {
  InboxWire,
  ListSpacesResponse,
  SendMessageResponse,
} from './types.js';

/**
 * End-to-end integration: real HTTP server on a loopback socket, real
 * fetch across the wire, real Clinic + persistence on a temp directory.
 *
 * These are the tests that caught Risk R6 (Date revive) at a realistic
 * layer: the earlier unit tests prove `deserializeSnapshot` works, but
 * only a boot-send-stop-reboot-read dance proves the server wires the
 * persistence path together correctly.
 */

async function fetchJson<T>(
  server: RunningServer,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: T; headers: Headers }> {
  const url = `http://${server.address.host}:${server.address.port}${path}`;
  const res = await fetch(url, init);
  const body = (await res.json()) as T;
  return { status: res.status, body, headers: res.headers };
}

function randomPort(): number {
  // 41000 + random offset; keeps us clear of both privileged ports
  // and the default 18790 so a stray real daemon never collides.
  return 41000 + Math.floor(Math.random() * 1000);
}

describe('server integration (real HTTP + real persistence)', () => {
  let tmp: string;
  let server: RunningServer | undefined;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'doctor-chaos-integration-'));
  });

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = undefined;
    }
    await rm(tmp, { recursive: true, force: true });
  });

  it('CRUD loop: send → list → get → move', async () => {
    server = await startServer({
      port: randomPort(),
      snapshotPath: join(tmp, 'snapshot.json'),
    });

    // Health check first — sanity + warms up the port binding.
    const health = await fetchJson<{ status: string; version: string }>(
      server,
      '/v1/health',
    );
    expect(health.status).toBe(200);
    expect(health.body.status).toBe('ok');
    expect(health.headers.get('X-DoctorChaos-Version')).toBe(health.body.version);

    // Send a message.
    const send = await fetchJson<SendMessageResponse>(
      server,
      '/v1/tenants/default/messages',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'user', content: 'first message over HTTP' }),
      },
    );
    expect(send.status).toBe(200);

    // Some router paths produce a space, some produce an inbox entry;
    // we only need to verify the response shape is valid JSON of the
    // right destination kind.
    expect(['topicSpace', 'inbox']).toContain(send.body.destination);

    // List spaces.
    const list = await fetchJson<ListSpacesResponse>(server, '/v1/tenants/default/spaces');
    expect(list.status).toBe(200);

    // If the send produced a space, we can fetch it directly.
    if (send.body.destination === 'topicSpace') {
      const spaceId = send.body.space.id;
      const fetched = await fetchJson(server, `/v1/tenants/default/spaces/${spaceId}`);
      expect(fetched.status).toBe(200);
    } else {
      const inbox = await fetchJson<InboxWire>(server, '/v1/tenants/default/inbox');
      expect(inbox.status).toBe(200);
      expect(inbox.body.totalMessageCount).toBeGreaterThan(0);
    }
  });

  it('packaging/check and lifecycle/check respond 200 with empty arrays on a fresh clinic', async () => {
    server = await startServer({
      port: randomPort(),
      snapshotPath: join(tmp, 'snapshot.json'),
    });

    const packaging = await fetchJson<{ createdSpaces: unknown[] }>(
      server,
      '/v1/tenants/default/packaging/check',
      { method: 'POST' },
    );
    expect(packaging.status).toBe(200);
    expect(packaging.body.createdSpaces).toEqual([]);

    const lifecycle = await fetchJson<{ changedSpaces: unknown[] }>(
      server,
      '/v1/tenants/default/lifecycle/check',
      { method: 'POST' },
    );
    expect(lifecycle.status).toBe(200);
    expect(lifecycle.body.changedSpaces).toEqual([]);
  });

  it('restart-preservation: state survives a full stop+start cycle', async () => {
    const snapshotPath = join(tmp, 'snapshot.json');
    const port = randomPort();

    // Boot 1: send a few messages.
    server = await startServer({ port, snapshotPath });
    for (const content of ['first', 'second', 'third']) {
      const res = await fetchJson(server, '/v1/tenants/default/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'user', content }),
      });
      expect(res.status).toBe(200);
    }

    // Capture pre-restart state.
    const before = await fetchJson<ListSpacesResponse>(
      server,
      '/v1/tenants/default/spaces',
    );
    const beforeInbox = await fetchJson<InboxWire>(
      server,
      '/v1/tenants/default/inbox',
    );

    // Stop + restart.
    await server.stop();
    server = await startServer({ port, snapshotPath });

    const after = await fetchJson<ListSpacesResponse>(
      server,
      '/v1/tenants/default/spaces',
    );
    const afterInbox = await fetchJson<InboxWire>(
      server,
      '/v1/tenants/default/inbox',
    );

    expect(after.body.spaces).toEqual(before.body.spaces);
    expect(afterInbox.body.totalMessageCount).toBe(beforeInbox.body.totalMessageCount);
    expect(afterInbox.body.fragments.length).toBe(beforeInbox.body.fragments.length);
  });
});
