import type { Hono } from 'hono';
import type { Clinic, TopicStatus } from '@doctorchaos-ai/core';
import {
  badRequest,
  messageNotFound,
  spaceNotFound,
  DoctorChaosHttpError,
} from './errors.js';
import type { AppEnv, PersistFn } from './http.js';
import { IdempotencyCache } from './idempotency.js';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  fragmentToWire,
  inboxToWire,
  messageToWire,
  topicSpaceToSummaryWire,
  topicSpaceToWire,
  type CheckLifecycleResponse,
  type CheckPackagingResponse,
  type InboxWire,
  type ListSpacesResponse,
  type MoveMessageRequest,
  type RoutingDecisionWire,
  type SendMessageRequest,
  type SendMessageResponse,
  type TopicSpaceWire,
} from './types.js';

/**
 * Dependencies that every Clinic-scoped route handler needs. Wrapped
 * in a struct so we can add more without changing every signature
 * (persistence strategy, future auth context, etc.).
 */
export interface RouteDeps {
  readonly clinic: Clinic;
  readonly persist: PersistFn;
  readonly idempotency: IdempotencyCache;
}

const VALID_ROLES = new Set(['user', 'assistant', 'system', 'tool']);

const VALID_STATUSES = new Set<TopicStatus>([
  'active',
  'dormant',
  'archived',
  'merged',
]);

/**
 * Mount every Clinic-scoped route onto `app`. Called from
 * {@link createHttpApp}; kept as a separate function so the test
 * harness can mount routes without going through the full app
 * factory.
 */
export function registerClinicRoutes(app: Hono<AppEnv>, deps: RouteDeps): void {
  const base = '/v1/tenants/:tenant_id';

  // ─── POST messages (Req 1) ────────────────────────────────────────

  app.post(`${base}/messages`, async (ctx) => {
    const tenantId = ctx.get('tenantId');
    const raw = await readJsonBody(ctx);
    const input = validateSendMessage(raw);

    // Idempotency fast-path.
    const replay = maybeReplay(deps.idempotency, tenantId, input.idempotency_key);
    if (replay) return ctx.json(replay.body, replay.status);

    const result = await deps.clinic.send({
      role: input.role,
      content: input.content,
      ...(input.id !== undefined ? { id: input.id } : {}),
      ...(input.timestamp !== undefined ? { timestamp: new Date(input.timestamp) } : {}),
    });

    let body: SendMessageResponse;
    if (result.destination === 'topicSpace') {
      body = {
        destination: 'topicSpace',
        space: topicSpaceToWire(result.space),
        isNewSpace: result.isNewSpace,
        message: messageToWire(result.message),
        decision: decisionToWire(result.decision),
      };
    } else {
      body = {
        destination: 'inbox',
        inbox: inboxToWire(result.inbox),
        fragment: fragmentToWire(result.fragment),
        message: messageToWire(result.message),
        decision: decisionToWire(result.decision),
      };
    }

    await deps.persist(deps.clinic);
    rememberReplay(deps.idempotency, tenantId, input.idempotency_key, 200, body);
    return ctx.json(body, 200);
  });

  // ─── GET spaces (Req 2.1, 2.2) ────────────────────────────────────

  app.get(`${base}/spaces`, (ctx) => {
    const statusParam = ctx.req.query('status');
    const statuses = parseStatusParam(statusParam);
    const spaces = deps.clinic.spaces(
      statuses !== undefined ? { status: statuses } : undefined,
    );
    const body: ListSpacesResponse = {
      spaces: spaces.map(topicSpaceToSummaryWire),
    };
    return ctx.json(body, 200);
  });

  // ─── GET spaces/:id (Req 2.3, 2.4) ────────────────────────────────

  app.get(`${base}/spaces/:space_id`, (ctx) => {
    const spaceId = ctx.req.param('space_id');
    if (!spaceId) {
      throw badRequest("Path segment 'space_id' is required.");
    }
    const space = deps.clinic.space(spaceId);
    if (!space) throw spaceNotFound(spaceId);
    const body: TopicSpaceWire = topicSpaceToWire(space);
    return ctx.json(body, 200);
  });

  // ─── GET inbox (Req 3.1) ─────────────────────────────────────────

  app.get(`${base}/inbox`, (ctx) => {
    const body: InboxWire = inboxToWire(deps.clinic.inbox());
    return ctx.json(body, 200);
  });

  // ─── POST packaging/check (Req 3.2) ──────────────────────────────

  app.post(`${base}/packaging/check`, async (ctx) => {
    const tenantId = ctx.get('tenantId');
    const raw = await readJsonBodyOptional(ctx);
    const idempotencyKey = getIdempotencyKey(raw);

    const replay = maybeReplay(deps.idempotency, tenantId, idempotencyKey);
    if (replay) return ctx.json(replay.body, replay.status);

    const created = await deps.clinic.checkPackaging();
    const body: CheckPackagingResponse = {
      createdSpaces: created.map(topicSpaceToWire),
    };
    if (created.length > 0) {
      await deps.persist(deps.clinic);
    }
    rememberReplay(deps.idempotency, tenantId, idempotencyKey, 200, body);
    return ctx.json(body, 200);
  });

  // ─── POST lifecycle/check (Req 3.3) ──────────────────────────────

  app.post(`${base}/lifecycle/check`, async (ctx) => {
    const tenantId = ctx.get('tenantId');
    const raw = await readJsonBodyOptional(ctx);
    const idempotencyKey = getIdempotencyKey(raw);

    const replay = maybeReplay(deps.idempotency, tenantId, idempotencyKey);
    if (replay) return ctx.json(replay.body, replay.status);

    const changed = await deps.clinic.checkLifecycle();
    const body: CheckLifecycleResponse = {
      changedSpaces: changed.map(topicSpaceToWire),
    };
    if (changed.length > 0) {
      await deps.persist(deps.clinic);
    }
    rememberReplay(deps.idempotency, tenantId, idempotencyKey, 200, body);
    return ctx.json(body, 200);
  });

  // ─── POST messages/:id/move (Req 3.4–3.6) ───────────────────────

  app.post(`${base}/messages/:message_id/move`, async (ctx) => {
    const tenantId = ctx.get('tenantId');
    const messageId = ctx.req.param('message_id');
    if (!messageId) {
      // Hono's type for dynamic path params is `string | undefined`;
      // in practice the route cannot match without this segment, so
      // this branch is defensive.
      throw badRequest("Path segment 'message_id' is required.");
    }
    const raw = await readJsonBody(ctx);
    const input = validateMoveMessage(raw);

    // Pre-validate both ids so we emit typed 404s rather than
    // letting `Clinic.moveMessage` throw opaque Error("unknown …").
    if (!deps.clinic.space(input.to_space_id)) {
      throw spaceNotFound(input.to_space_id);
    }
    if (!messageExistsSomewhere(deps.clinic, messageId)) {
      throw messageNotFound(messageId);
    }

    const replay = maybeReplay(deps.idempotency, tenantId, input.idempotency_key);
    if (replay) return ctx.json(replay.body, replay.status);

    const updated = await deps.clinic.moveMessage(messageId, input.to_space_id);
    const body: TopicSpaceWire = topicSpaceToWire(updated);
    await deps.persist(deps.clinic);
    rememberReplay(deps.idempotency, tenantId, input.idempotency_key, 200, body);
    return ctx.json(body, 200);
  });
}

// ─── Body parsing + validation ───────────────────────────────────────

async function readJsonBody(ctx: {
  req: { json: () => Promise<unknown>; header: (name: string) => string | undefined };
}): Promise<Record<string, unknown>> {
  const contentType = ctx.req.header('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw badRequest("Expected Content-Type 'application/json'.");
  }
  let body: unknown;
  try {
    body = await ctx.req.json();
  } catch {
    throw badRequest('Request body is not valid JSON.');
  }
  if (!isRecord(body)) {
    throw badRequest('Request body must be a JSON object.');
  }
  return body;
}

async function readJsonBodyOptional(ctx: {
  req: { json: () => Promise<unknown>; header: (name: string) => string | undefined };
}): Promise<Record<string, unknown>> {
  const contentType = ctx.req.header('content-type') ?? '';
  // An empty or non-JSON body is allowed for bodyless POSTs like
  // `packaging:check`; treat it as an empty object.
  if (!contentType.toLowerCase().includes('application/json')) {
    return {};
  }
  try {
    const body = await ctx.req.json();
    return isRecord(body) ? body : {};
  } catch {
    // Accept empty bodies silently — a retry with no body is fine.
    return {};
  }
}

function validateSendMessage(raw: Record<string, unknown>): SendMessageRequest {
  const role = raw['role'];
  if (typeof role !== 'string' || !VALID_ROLES.has(role)) {
    throw badRequest(
      "Field 'role' must be one of: 'user', 'assistant', 'system', 'tool'.",
    );
  }
  const content = raw['content'];
  if (typeof content !== 'string') {
    throw badRequest("Field 'content' must be a string.");
  }
  const id = raw['id'];
  if (id !== undefined && typeof id !== 'string') {
    throw badRequest("Field 'id', if present, must be a string.");
  }
  const timestamp = raw['timestamp'];
  if (timestamp !== undefined) {
    if (typeof timestamp !== 'string') {
      throw badRequest("Field 'timestamp', if present, must be an ISO 8601 string.");
    }
    if (Number.isNaN(Date.parse(timestamp))) {
      throw badRequest(`Field 'timestamp' is not a valid ISO 8601 date: '${timestamp}'.`);
    }
  }
  const idempotencyKey = raw['idempotency_key'];
  if (idempotencyKey !== undefined && typeof idempotencyKey !== 'string') {
    throw badRequest("Field 'idempotency_key', if present, must be a string.");
  }
  return {
    role: role as SendMessageRequest['role'],
    content,
    ...(id !== undefined ? { id } : {}),
    ...(timestamp !== undefined ? { timestamp } : {}),
    ...(idempotencyKey !== undefined ? { idempotency_key: idempotencyKey } : {}),
  };
}

function validateMoveMessage(raw: Record<string, unknown>): MoveMessageRequest {
  const toSpaceId = raw['to_space_id'];
  if (typeof toSpaceId !== 'string' || toSpaceId.length === 0) {
    throw badRequest("Field 'to_space_id' must be a non-empty string.");
  }
  const idempotencyKey = raw['idempotency_key'];
  if (idempotencyKey !== undefined && typeof idempotencyKey !== 'string') {
    throw badRequest("Field 'idempotency_key', if present, must be a string.");
  }
  return {
    to_space_id: toSpaceId,
    ...(idempotencyKey !== undefined ? { idempotency_key: idempotencyKey } : {}),
  };
}

function getIdempotencyKey(raw: Record<string, unknown>): string | undefined {
  const key = raw['idempotency_key'];
  if (key === undefined) return undefined;
  if (typeof key !== 'string') {
    throw badRequest("Field 'idempotency_key', if present, must be a string.");
  }
  return key;
}

function parseStatusParam(raw: string | undefined): TopicStatus[] | undefined {
  if (!raw) return undefined;
  const parts = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  if (parts.length === 0) return undefined;
  for (const p of parts) {
    if (!VALID_STATUSES.has(p as TopicStatus)) {
      throw badRequest(
        `Query parameter 'status' contains unknown value: '${p}'. Valid values: active, dormant, archived, merged.`,
      );
    }
  }
  return parts as TopicStatus[];
}

// ─── Idempotency helpers ────────────────────────────────────────────

function maybeReplay(
  cache: IdempotencyCache,
  tenantId: string,
  idempotencyKey: string | undefined,
): { status: ContentfulStatusCode; body: unknown } | undefined {
  if (!idempotencyKey) return undefined;
  const cached = cache.get(IdempotencyCache.buildKey(tenantId, idempotencyKey));
  if (!cached) return undefined;
  return { status: cached.status, body: cached.body };
}

function rememberReplay(
  cache: IdempotencyCache,
  tenantId: string,
  idempotencyKey: string | undefined,
  status: ContentfulStatusCode,
  body: unknown,
): void {
  if (!idempotencyKey) return;
  cache.set(IdempotencyCache.buildKey(tenantId, idempotencyKey), { status, body });
}

// ─── Small helpers ───────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function decisionToWire(decision: {
  readonly destination:
    | { readonly kind: 'existingTopicSpace'; readonly topicSpace: { readonly id: string } }
    | { readonly kind: 'newTopicSpace'; readonly suggestedName: string }
    | { readonly kind: 'inbox' };
  readonly confidence: number;
  readonly reasoning: string;
}): RoutingDecisionWire {
  const d = decision.destination;
  if (d.kind === 'existingTopicSpace') {
    return {
      destination: { kind: 'existingTopicSpace', topicSpaceId: d.topicSpace.id },
      confidence: decision.confidence,
      reasoning: decision.reasoning,
    };
  }
  if (d.kind === 'newTopicSpace') {
    return {
      destination: { kind: 'newTopicSpace', suggestedName: d.suggestedName },
      confidence: decision.confidence,
      reasoning: decision.reasoning,
    };
  }
  return {
    destination: { kind: 'inbox' },
    confidence: decision.confidence,
    reasoning: decision.reasoning,
  };
}

function messageExistsSomewhere(clinic: Clinic, messageId: string): boolean {
  for (const s of clinic.spaces()) {
    if (s.messages.some((m) => m.id === messageId)) return true;
  }
  for (const f of clinic.inbox().fragments) {
    if (f.messages.some((m) => m.id === messageId)) return true;
  }
  return false;
}

// Re-export for tests that want to assert error class identity.
export { DoctorChaosHttpError };
