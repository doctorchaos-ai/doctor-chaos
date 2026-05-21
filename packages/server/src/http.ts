import { Hono } from 'hono';
import type { Clinic } from '@doctorchaos-ai/core';
import { VERSION } from './version.js';
import { createErrorHandler, tenantNotFound } from './errors.js';
import { IdempotencyCache } from './idempotency.js';
import {
  defaultRequestLogger,
  loggingMiddleware,
  requestIdMiddleware,
  type RequestLogger,
} from './logging.js';
import { registerClinicRoutes } from './routes.js';

/**
 * Context variables the daemon attaches to every request. Declaring
 * them here lets every module use a single `AppContext`-typed Hono
 * instance and get type-safe `ctx.set` / `ctx.get` calls.
 *
 * Keep this in sync with the `CTX_*` string constants in
 * {@link ./logging.js}.
 */
export interface AppVariables {
  requestId: string;
  requestStart: number;
  tenantId: string;
  errCode: string;
}

export type AppEnv = { Variables: AppVariables };

/**
 * The literal tenant id accepted by the current build. The URL path
 * segment is retained so that future multi-tenant builds can light
 * up without breaking the wire protocol.
 *
 * @internal
 */
const DEFAULT_TENANT_ID = 'default';

/**
 * Persistence callback invoked after every successful write. The
 * server layer owns the snapshot write policy (write-through after
 * mutation); route handlers only need to say "I just mutated
 * something, please persist."
 */
export type PersistFn = (clinic: Clinic) => Promise<void>;

/**
 * Construction options for {@link createHttpApp}.
 */
export interface HttpAppOptions {
  /**
   * The single-tenant Clinic instance the daemon wraps. Required in
   * practice; left optional here so the test harness can mount the
   * HTTP skeleton without a Clinic to assert middleware behaviour in
   * isolation.
   */
  readonly clinic?: Clinic;

  /**
   * Called after every mutating endpoint. Receives the same Clinic
   * instance you passed in; should serialise `clinic.snapshot()` and
   * write it to disk. A no-op default is used in tests.
   */
  readonly persist?: PersistFn;

  /**
   * Process-local idempotency cache. If omitted, a fresh cache is
   * created with default capacity (1000) and TTL (10 min).
   */
  readonly idempotency?: IdempotencyCache;

  /** Structured-log sink. Defaults to `console.log` (one JSON per line). */
  readonly logger?: RequestLogger;

  /** Unhandled-error sink. Defaults to `console.error`. */
  readonly errorSink?: (err: unknown) => void;
}

/**
 * Build the daemon's Hono application with all middleware wired up
 * and all route handlers mounted.
 *
 * Middleware order (top is outermost):
 *   1. `X-DoctorChaos-Version` response header
 *   2. `requestIdMiddleware` — assigns `request_id`, sets `X-Request-Id`
 *   3. `loggingMiddleware` — records start time, emits structured log
 *      on the way out
 *   4. `/v1/health` — no auth, no tenant guard
 *   5. `/v1/tenants/:tenant_id/*` — tenant guard, then route handlers
 *
 * Error handling is attached via `app.onError(...)`, which runs after
 * route handlers throw but before the response reaches the logging
 * middleware. That ordering lets the logger see the final status
 * and `err_code`.
 */
export function createHttpApp(options: HttpAppOptions = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const idempotency = options.idempotency ?? new IdempotencyCache();
  const persist: PersistFn = options.persist ?? (async () => undefined);

  // 1. Stamp the X-DoctorChaos-Version header on every response.
  app.use('*', async (ctx, next) => {
    ctx.header('X-DoctorChaos-Version', VERSION);
    await next();
  });

  // 2. Request id + structured logging.
  app.use('*', requestIdMiddleware());
  app.use('*', loggingMiddleware(options.logger ?? defaultRequestLogger));

  // 3. Health endpoint. No tenant id, no auth, always available.
  app.get('/v1/health', (ctx) => {
    return ctx.json({ status: 'ok', version: VERSION });
  });

  // 4. Tenant-scoped endpoints.
  app.use('/v1/tenants/:tenant_id/*', async (ctx, next) => {
    const tenantId = ctx.req.param('tenant_id');
    if (tenantId !== DEFAULT_TENANT_ID) {
      throw tenantNotFound(tenantId);
    }
    ctx.set('tenantId', tenantId);
    await next();
  });

  // 5. Route handlers — only mounted when a Clinic is supplied. This
  //    keeps middleware-only test cases cheap (they never need to
  //    construct a Clinic) while real runtime always provides one.
  if (options.clinic) {
    registerClinicRoutes(app, {
      clinic: options.clinic,
      persist,
      idempotency,
    });
  }

  // Global error handler. Registered after routes so Hono routes
  // unhandled throws into it.
  app.onError(createErrorHandler(options.errorSink));

  return app;
}
