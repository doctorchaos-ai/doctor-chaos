import type { Context, MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppEnv } from './http.js';
import { CTX_ERR_CODE, CTX_REQUEST_ID } from './logging.js';

/**
 * The stable vocabulary of `code` values the daemon may return in
 * error response bodies. Clients parse this field to map to typed
 * exceptions; documented in the package README.
 *
 * Keep this list append-only. Removing or renaming a code is a
 * breaking wire-protocol change and requires a version bump.
 */
export type ErrorCode =
  | 'bad_request'
  | 'tenant_not_found'
  | 'space_not_found'
  | 'message_not_found'
  | 'internal_error';

/**
 * HTTP status that the daemon returns for each {@link ErrorCode}.
 *
 * Typed as `ContentfulStatusCode` because every error response
 * carries a JSON body; Hono's `ctx.json` refuses 1xx / 204 / 304.
 *
 * @internal
 */
export const ERROR_STATUS: Record<ErrorCode, ContentfulStatusCode> = {
  bad_request: 400,
  tenant_not_found: 404,
  space_not_found: 404,
  message_not_found: 404,
  internal_error: 500,
};

/**
 * Exception thrown by route handlers and middlewares to signal a
 * well-formed error response. The global `onError` handler catches
 * these, formats the JSON body, and logs an appropriate line.
 */
export class DoctorChaosHttpError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: ContentfulStatusCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'DoctorChaosHttpError';
    this.code = code;
    this.statusCode = ERROR_STATUS[code];
  }
}

export function badRequest(message: string): DoctorChaosHttpError {
  return new DoctorChaosHttpError('bad_request', message);
}

export function tenantNotFound(tenantId: string): DoctorChaosHttpError {
  return new DoctorChaosHttpError(
    'tenant_not_found',
    `Tenant '${tenantId}' not found. This build only supports 'default'.`,
  );
}

export function spaceNotFound(spaceId: string): DoctorChaosHttpError {
  return new DoctorChaosHttpError('space_not_found', `Space '${spaceId}' not found.`);
}

export function messageNotFound(messageId: string): DoctorChaosHttpError {
  return new DoctorChaosHttpError('message_not_found', `Message '${messageId}' not found.`);
}

/**
 * JSON body shape returned for every error response.
 */
export interface ErrorBody {
  readonly code: ErrorCode;
  readonly message: string;
  readonly request_id: string;
}

/**
 * Hono global `onError` handler factory.
 *
 * Translates {@link DoctorChaosHttpError} into the documented error
 * body shape; maps every other thrown value to HTTP 500 with code
 * `internal_error`. Stack traces go to the error sink (defaults to
 * `console.error`), never to the response body.
 *
 * Also stamps the chosen `err_code` into the Hono context so the
 * logging middleware can include it in its per-request structured
 * log line.
 */
export function createErrorHandler(
  errorSink: (err: unknown) => void = defaultErrorSink,
): (err: Error, ctx: Context<AppEnv>) => Response {
  return (err, ctx) => {
    const requestId = safeRequestId(ctx);

    if (err instanceof DoctorChaosHttpError) {
      ctx.set(CTX_ERR_CODE, err.code);
      const body: ErrorBody = {
        code: err.code,
        message: err.message,
        request_id: requestId,
      };
      return ctx.json(body, err.statusCode);
    }

    // Unexpected throw: log full stack server-side, return sanitized
    // body to the client.
    errorSink(err);
    ctx.set(CTX_ERR_CODE, 'internal_error' satisfies ErrorCode);
    const body: ErrorBody = {
      code: 'internal_error',
      message: 'An internal error occurred. Check daemon logs with the request_id.',
      request_id: requestId,
    };
    return ctx.json(body, 500);
  };
}

/**
 * @internal
 */
function defaultErrorSink(err: unknown): void {
  // eslint-disable-next-line no-console
  console.error('[doctor-chaos-server] unhandled error:', err);
}

/**
 * Reserved for future request-scoped cleanup. Currently a no-op — the
 * real translation from throw to JSON lives in {@link createErrorHandler}
 * which is plugged into Hono's global `onError` hook.
 *
 * Kept as an exported symbol so route files can mount it now without
 * churn when cleanup logic is added.
 */
export function errorFormatMiddleware(): MiddlewareHandler<AppEnv> {
  return async (_ctx, next) => {
    await next();
  };
}

/**
 * @internal
 */
function safeRequestId(ctx: Context<AppEnv>): string {
  try {
    return ctx.get(CTX_REQUEST_ID);
  } catch {
    return 'req-unknown';
  }
}
