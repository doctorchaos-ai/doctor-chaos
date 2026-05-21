import type { Context, MiddlewareHandler } from 'hono';
import { randomUUID } from 'node:crypto';
import type { AppEnv } from './http.js';

/**
 * Context variable names this module writes into Hono's `ctx.set` /
 * `ctx.get` so route handlers and the error formatter can read them
 * with type safety.
 *
 * Keep in sync with `AppVariables` in {@link ./http.js}.
 *
 * @internal
 */
export const CTX_REQUEST_ID = 'requestId' as const;
export const CTX_REQUEST_START = 'requestStart' as const;
export const CTX_TENANT_ID = 'tenantId' as const;
export const CTX_ERR_CODE = 'errCode' as const;

/**
 * A single structured log record we emit per HTTP request.
 *
 * Fields are chosen to be grep-friendly from a terminal: one JSON
 * object per line, no nested structures unless strictly necessary.
 */
export interface RequestLogRecord {
  readonly request_id: string;
  readonly tenant_id: string | null;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly duration_ms: number;
  readonly err_code?: string;
}

/**
 * The logger function contract. Defaults to `console.log` but tests
 * and host applications can swap in a spy or a structured sink.
 */
export type RequestLogger = (record: RequestLogRecord) => void;

/**
 * Default sink — writes one JSON line per request to stdout.
 *
 * @internal
 */
export const defaultRequestLogger: RequestLogger = (record) => {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(record));
};

/**
 * Middleware: attach a unique request id to the context and to the
 * `X-Request-Id` response header.
 *
 * Must be mounted before every other middleware so later code can
 * read the id from context regardless of where in the stack the
 * response is produced.
 */
export function requestIdMiddleware(): MiddlewareHandler<AppEnv> {
  return async (ctx, next) => {
    const id = `req-${randomUUID()}`;
    ctx.set(CTX_REQUEST_ID, id);
    ctx.header('X-Request-Id', id);
    await next();
  };
}

/**
 * Middleware: record a single structured log line per request.
 *
 * Records the high-resolution start time on the way in, computes
 * duration on the way out, and picks up `err_code` from context if
 * the error formatter set one.
 */
export function loggingMiddleware(
  logger: RequestLogger = defaultRequestLogger,
): MiddlewareHandler<AppEnv> {
  return async (ctx, next) => {
    const start = performance.now();
    ctx.set(CTX_REQUEST_START, start);
    await next();
    const duration = performance.now() - start;
    const errCode = safeGet(ctx, CTX_ERR_CODE);
    const tenantId = safeGet(ctx, CTX_TENANT_ID) ?? null;
    const record: RequestLogRecord = {
      request_id: ctx.get(CTX_REQUEST_ID),
      tenant_id: tenantId,
      method: ctx.req.method,
      path: ctx.req.path,
      status: ctx.res.status,
      duration_ms: Math.round(duration * 100) / 100,
      ...(errCode !== undefined ? { err_code: errCode } : {}),
    };
    logger(record);
  };
}

/**
 * Read a context variable that may not have been set. Hono's typed
 * `ctx.get` assumes presence; this wrapper returns `undefined` on
 * absence without tripping the type system.
 *
 * @internal
 */
function safeGet<K extends keyof import('./http.js').AppVariables>(
  ctx: Context<AppEnv>,
  key: K,
): import('./http.js').AppVariables[K] | undefined {
  try {
    return ctx.get(key);
  } catch {
    return undefined;
  }
}
