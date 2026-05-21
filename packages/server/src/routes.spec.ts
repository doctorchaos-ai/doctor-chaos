import { beforeEach, describe, expect, it } from 'vitest';
import { Clinic, createInboxSpace, type TopicSpace } from '@doctorchaos-ai/core';
import { createHttpApp } from './http.js';
import type {
  CheckLifecycleResponse,
  CheckPackagingResponse,
  InboxWire,
  ListSpacesResponse,
  SendMessageResponse,
  TopicSpaceWire,
} from './types.js';

/**
 * End-to-end (in-process) tests for every Clinic-scoped HTTP route.
 *
 * Spin up a real {@link Clinic} behind Hono's `app.request` — no
 * network, but every layer from validation through routing to
 * wire-format conversion is exercised. Assertions cover the happy
 * path plus every declared 4xx from Requirements 1–3.
 *
 * Most tests pre-seed the Clinic with a known topic space so routing
 * outcomes are stable; routing dynamics live in core's own tests.
 */

function seededClinic(): Clinic {
  const now = new Date('2026-05-10T08:00:00.000Z');
  const seedSpace: TopicSpace = {
    id: 'seed-space',
    name: '既有空间',
    keywords: ['keyword-one', 'keyword-two'],
    createdDate: new Date('2026-05-01T00:00:00.000Z'),
    lastActivityDate: now,
    creationSource: 'user',
    status: 'active',
    messages: [
      {
        id: 'seed-msg',
        role: 'user',
        content: 'a seed message',
        timestamp: now,
      },
    ],
  };
  return new Clinic({
    autoDetectOpenAI: false,
    initialSpaces: [seedSpace],
    initialInbox: createInboxSpace(),
  });
}

function harnessWithSeed(): { app: ReturnType<typeof createHttpApp>; clinic: Clinic } {
  const clinic = seededClinic();
  const app = createHttpApp({ clinic, logger: () => {} });
  return { app, clinic };
}

async function postJson<T>(
  app: ReturnType<typeof createHttpApp>,
  path: string,
  body: unknown,
): Promise<{ status: number; body: T }> {
  const res = await app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

async function getJson<T>(
  app: ReturnType<typeof createHttpApp>,
  path: string,
): Promise<{ status: number; body: T }> {
  const res = await app.request(path);
  return { status: res.status, body: (await res.json()) as T };
}

// ─── POST /v1/tenants/default/messages ──────────────────────────────

describe('POST /v1/tenants/default/messages', () => {
  let app: ReturnType<typeof createHttpApp>;

  beforeEach(() => {
    app = harnessWithSeed().app;
  });

  it('accepts a well-formed send and returns a routing decision', async () => {
    const res = await postJson<SendMessageResponse>(
      app,
      '/v1/tenants/default/messages',
      { role: 'user', content: 'keyword-one helps route this' },
    );
    expect(res.status).toBe(200);
    expect(['topicSpace', 'inbox']).toContain(res.body.destination);
    expect(res.body.decision).toHaveProperty('reasoning');
    expect(res.body.decision).toHaveProperty('confidence');
    expect(typeof res.body.message.id).toBe('string');
  });

  it('rejects a body missing required fields with bad_request', async () => {
    const res = await postJson<{ code: string }>(
      app,
      '/v1/tenants/default/messages',
      { content: 'no role given' },
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('bad_request');
  });

  it('replays responses for the same idempotency key', async () => {
    const first = await postJson<SendMessageResponse>(
      app,
      '/v1/tenants/default/messages',
      { role: 'user', content: 'hello world', idempotency_key: 'abc-123' },
    );
    const second = await postJson<SendMessageResponse>(
      app,
      '/v1/tenants/default/messages',
      { role: 'user', content: 'hello world', idempotency_key: 'abc-123' },
    );
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
  });

  it('rejects non-JSON content type', async () => {
    const res = await app.request('/v1/tenants/default/messages', {
      method: 'POST',
      body: 'not json',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('bad_request');
  });

  it('rejects an invalid role string', async () => {
    const res = await postJson<{ code: string }>(
      app,
      '/v1/tenants/default/messages',
      { role: 'narrator', content: 'hi' },
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('bad_request');
  });
});

// ─── GET /v1/tenants/default/spaces ─────────────────────────────────

describe('GET /v1/tenants/default/spaces', () => {
  it('returns summaries without messages array', async () => {
    const { app } = harnessWithSeed();
    const res = await getJson<ListSpacesResponse>(app, '/v1/tenants/default/spaces');
    expect(res.status).toBe(200);
    expect(res.body.spaces.length).toBeGreaterThan(0);
    const first = res.body.spaces[0]!;
    expect(first).toHaveProperty('messageCount');
    expect(first).not.toHaveProperty('messages');
  });

  it('filters by status', async () => {
    const { app } = harnessWithSeed();
    const activeOnly = await getJson<ListSpacesResponse>(
      app,
      '/v1/tenants/default/spaces?status=active',
    );
    expect(activeOnly.status).toBe(200);
    expect(activeOnly.body.spaces.every((s) => s.status === 'active')).toBe(true);

    const archivedOnly = await getJson<ListSpacesResponse>(
      app,
      '/v1/tenants/default/spaces?status=archived',
    );
    expect(archivedOnly.status).toBe(200);
    expect(archivedOnly.body.spaces).toHaveLength(0);
  });

  it('rejects an invalid status query parameter', async () => {
    const { app } = harnessWithSeed();
    const res = await getJson<{ code: string }>(
      app,
      '/v1/tenants/default/spaces?status=unknown',
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('bad_request');
  });
});

// ─── GET /v1/tenants/default/spaces/:space_id ───────────────────────

describe('GET /v1/tenants/default/spaces/:space_id', () => {
  it('returns the full topic space including messages', async () => {
    const { app } = harnessWithSeed();
    const res = await getJson<TopicSpaceWire>(
      app,
      '/v1/tenants/default/spaces/seed-space',
    );
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('seed-space');
    expect(res.body.messages).toHaveLength(1);
    expect(res.body.messages[0]?.content).toBe('a seed message');
    // Wire format: Date fields come back as ISO strings.
    expect(typeof res.body.createdDate).toBe('string');
    expect(() => new Date(res.body.createdDate)).not.toThrow();
  });

  it('returns space_not_found for unknown space id', async () => {
    const { app } = harnessWithSeed();
    const res = await getJson<{ code: string }>(
      app,
      '/v1/tenants/default/spaces/nope',
    );
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('space_not_found');
  });
});

// ─── GET /v1/tenants/default/inbox ──────────────────────────────────

describe('GET /v1/tenants/default/inbox', () => {
  it('returns an empty inbox on a fresh clinic', async () => {
    const { app } = harnessWithSeed();
    const res = await getJson<InboxWire>(app, '/v1/tenants/default/inbox');
    expect(res.status).toBe(200);
    expect(res.body.totalMessageCount).toBe(0);
    expect(res.body.fragments).toHaveLength(0);
  });
});

// ─── POST packaging/check ───────────────────────────────────────────

describe('POST /v1/tenants/default/packaging/check', () => {
  it('returns an empty createdSpaces array when nothing qualifies', async () => {
    const { app } = harnessWithSeed();
    const res = await postJson<CheckPackagingResponse>(
      app,
      '/v1/tenants/default/packaging/check',
      {},
    );
    expect(res.status).toBe(200);
    expect(res.body.createdSpaces).toEqual([]);
  });

  it('accepts a bodyless request', async () => {
    const { app } = harnessWithSeed();
    const res = await app.request('/v1/tenants/default/packaging/check', {
      method: 'POST',
    });
    expect(res.status).toBe(200);
  });
});

// ─── POST lifecycle/check ───────────────────────────────────────────

describe('POST /v1/tenants/default/lifecycle/check', () => {
  it('returns an empty changedSpaces array when nothing qualifies', async () => {
    const { app } = harnessWithSeed();
    const res = await postJson<CheckLifecycleResponse>(
      app,
      '/v1/tenants/default/lifecycle/check',
      {},
    );
    expect(res.status).toBe(200);
    expect(res.body.changedSpaces).toEqual([]);
  });
});

// ─── POST messages/:id/move ─────────────────────────────────────────

describe('POST /v1/tenants/default/messages/:message_id/move', () => {
  it('moves a known message to a new target space', async () => {
    // Create a second space by direct Clinic construction so we have
    // a clean move target; then create the HTTP harness around it.
    const existingSpace: TopicSpace = {
      id: 'seed-space',
      name: 'source',
      keywords: [],
      createdDate: new Date('2026-05-01T00:00:00.000Z'),
      lastActivityDate: new Date('2026-05-10T08:00:00.000Z'),
      creationSource: 'user',
      status: 'active',
      messages: [
        {
          id: 'moveable-msg',
          role: 'user',
          content: 'please move me',
          timestamp: new Date('2026-05-10T08:00:00.000Z'),
        },
      ],
    };
    const targetSpace: TopicSpace = {
      id: 'target-space',
      name: 'target',
      keywords: [],
      createdDate: new Date('2026-05-02T00:00:00.000Z'),
      lastActivityDate: new Date('2026-05-10T08:00:00.000Z'),
      creationSource: 'user',
      status: 'active',
      messages: [],
    };
    const clinic = new Clinic({
      autoDetectOpenAI: false,
      initialSpaces: [existingSpace, targetSpace],
      initialInbox: createInboxSpace(),
    });
    const app = createHttpApp({ clinic, logger: () => {} });

    const res = await postJson<TopicSpaceWire>(
      app,
      '/v1/tenants/default/messages/moveable-msg/move',
      { to_space_id: 'target-space' },
    );
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('target-space');
    expect(res.body.messages.some((m) => m.id === 'moveable-msg')).toBe(true);
  });

  it('returns space_not_found for unknown target space', async () => {
    const { app } = harnessWithSeed();
    const res = await postJson<{ code: string }>(
      app,
      '/v1/tenants/default/messages/seed-msg/move',
      { to_space_id: 'no-such-space' },
    );
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('space_not_found');
  });

  it('returns message_not_found for unknown source message', async () => {
    const { app } = harnessWithSeed();
    const res = await postJson<{ code: string }>(
      app,
      '/v1/tenants/default/messages/no-such-message/move',
      { to_space_id: 'seed-space' },
    );
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('message_not_found');
  });

  it('rejects missing to_space_id with bad_request', async () => {
    const { app } = harnessWithSeed();
    const res = await postJson<{ code: string }>(
      app,
      '/v1/tenants/default/messages/seed-msg/move',
      {},
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('bad_request');
  });
});

// ─── Persistence hook ───────────────────────────────────────────────

describe('persistence hook', () => {
  it('is invoked after a successful send', async () => {
    const clinic = seededClinic();
    const calls: number[] = [];
    const app = createHttpApp({
      clinic,
      persist: async () => {
        calls.push(1);
      },
      logger: () => {},
    });
    const res = await postJson(app, '/v1/tenants/default/messages', {
      role: 'user',
      content: 'trigger persist',
    });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it('is invoked after a successful move', async () => {
    const existing: TopicSpace = {
      id: 'src',
      name: 'src',
      keywords: [],
      createdDate: new Date('2026-05-01T00:00:00.000Z'),
      lastActivityDate: new Date('2026-05-10T08:00:00.000Z'),
      creationSource: 'user',
      status: 'active',
      messages: [
        {
          id: 'm1',
          role: 'user',
          content: 'hi',
          timestamp: new Date('2026-05-10T08:00:00.000Z'),
        },
      ],
    };
    const target: TopicSpace = {
      id: 'dst',
      name: 'dst',
      keywords: [],
      createdDate: new Date('2026-05-02T00:00:00.000Z'),
      lastActivityDate: new Date('2026-05-10T08:00:00.000Z'),
      creationSource: 'user',
      status: 'active',
      messages: [],
    };
    const clinic = new Clinic({
      autoDetectOpenAI: false,
      initialSpaces: [existing, target],
      initialInbox: createInboxSpace(),
    });
    const calls: number[] = [];
    const app = createHttpApp({
      clinic,
      persist: async () => {
        calls.push(1);
      },
      logger: () => {},
    });
    const res = await postJson(app, '/v1/tenants/default/messages/m1/move', {
      to_space_id: 'dst',
    });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
  });
});
