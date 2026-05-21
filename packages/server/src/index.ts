/**
 * @doctorchaos-ai/server
 *
 * HTTP daemon that wraps the {@link @doctorchaos-ai/core#Clinic} class
 * and exposes topic-routing operations over localhost HTTP. The point
 * of this package is to let non-TypeScript agents (Hermes, other
 * Python tooling, future Go/Rust/Swift clients) drive Doctor Chaos
 * through a thin wire protocol instead of reimplementing routing in
 * every host language.
 *
 * Scope: alpha, localhost-only, single tenant (`tenant_id` is always
 * the literal string `"default"` on the wire). See `deferred-
 * requirements.md` in the spec directory for the terminal-state items
 * that are deliberately out of scope right now.
 */

/**
 * Current package version. Re-exported from {@link ./version.js}; kept
 * at the top of the public entry for convenient discovery.
 */
export { VERSION } from './version.js';

export { createHttpApp, type HttpAppOptions } from './http.js';
export {
  DoctorChaosHttpError,
  type ErrorCode,
  type ErrorBody,
  badRequest,
  tenantNotFound,
  spaceNotFound,
  messageNotFound,
} from './errors.js';
export {
  type RequestLogger,
  type RequestLogRecord,
  defaultRequestLogger,
} from './logging.js';
