/**
 * Ambient declaration for the OpenClaw plugin SDK surface this plugin uses.
 *
 * Lets the package build standalone (without OpenClaw installed). At OpenClaw
 * runtime the real module is resolved by the host.
 *
 * Confirmed against OpenClaw source/docs:
 *  - SDK entry helper is `definePluginEntry` from `openclaw/plugin-sdk/plugin-entry`
 *    (docs/plugins/sdk-entrypoints.md).
 *  - The `register(api)` callback's `api` exposes `registerContextEngine(id, factory)`
 *    (src/plugins/api-builder.ts).
 *
 * ⚠️ TASK 1.2 CHECKPOINT: confirm the exact `api.registerContextEngine`
 * signature and `definePluginEntry` option names on-device during the first
 * `openclaw plugins install -l`. If they differ, this file + `src/index.ts` are
 * the only seam to adjust.
 */
declare module 'openclaw/plugin-sdk/plugin-entry' {
  import type { ContextEngineFactory } from './openclaw-types.js';

  export interface OpenClawPluginApi {
    registerContextEngine(id: string, factory: ContextEngineFactory): unknown;
    [key: string]: unknown;
  }

  export interface PluginEntryConfig {
    id: string;
    name?: string;
    description?: string;
    version?: string;
    register(api: OpenClawPluginApi): void | Promise<void>;
  }

  export function definePluginEntry(config: PluginEntryConfig): PluginEntryConfig;
}
