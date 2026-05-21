import { describe, expect, it } from 'vitest';
import { createHttpApp } from './http.js';
import { VERSION } from './version.js';
import type { RequestLogRecord } from './logging.js';

/**
 * Smoke tests for the HTTP skeleton. These exercise the middleware
 * stack end-to-end through Hono's `app.request()` API (no real
 * network), covering:
 *   - X-Request-Id is present and looks like a UUID-based id
 *   - X-DoctorChaos-Version matches the package version
 *   - GET /v1/health works without auth
 *   - Tenant guard rejects anything other than `default`
 *   - Logger sees a structured record for every request
 */

describe('createHttpApp', () => {
  it('returns 200 on /v1/health with version', async () => {
    const app = createHttpApp({ logger: () => {} });
    const res = await app.request('/v1/health');

    expect(res.status).toBe(200);
    expect(res.headers.get('X-DoctorChaos-Version')).toBe(VERSION);
    expect(res.headers.get('X-Request-Id')).toMatch(/^req-/);
    await expect(res.json()).resolves.toEqual({ status: 'ok', version: VERSION });
  });

  it('rejects unknown tenant id with tenant_not_found', async () => {
    const app = createHttpApp({ logger: () => {} });
    // Hit a tenant-scoped path; route handlers are not mounted yet so
    // Hono would 404, but the tenant guard must fire first for any
    // id other than `default`.
    const res = await app.request('/v1/tenants/other-tenant/spaces');

    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      code: string;
      message: string;
      request_id: string;
    };
    expect(body.code).toBe('tenant_not_found');
    expect(body.request_id).toMatch(/^req-/);
  });

  it('emits a structured log record for every request', async () => {
    const records: RequestLogRecord[] = [];
    const app = createHttpApp({ logger: (r) => records.push(r) });

    await app.request('/v1/health');
    await app.request('/v1/tenants/other/spaces');

    expect(records).toHaveLength(2);
    expect(records[0]?.status).toBe(200);
    expect(records[0]?.path).toBe('/v1/health');
    expect(records[1]?.status).toBe(404);
    expect(records[1]?.err_code).toBe('tenant_not_found');
  });

  it('sets X-DoctorChaos-Version on error responses too', async () => {
    const app = createHttpApp({ logger: () => {} });
    const res = await app.request('/v1/tenants/other/spaces');
    expect(res.headers.get('X-DoctorChaos-Version')).toBe(VERSION);
  });
});
