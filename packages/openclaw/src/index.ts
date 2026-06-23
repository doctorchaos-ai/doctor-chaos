/**
 * @doctorchaos-ai/openclaw
 *
 * Doctor Chaos as an OpenClaw ContextEngine plugin. Exports the default plugin
 * entry; on `register(api)`, registers the "doctor-chaos" engine with
 * OpenClaw's context-engine registry. Users select it via
 * `plugins.slots.contextEngine: "doctor-chaos"` in openclaw.json.
 *
 * Entry convention confirmed against OpenClaw docs/source:
 *  - default export is a `definePluginEntry({...})` object
 *    (docs/plugins/sdk-entrypoints.md).
 *  - `package.json` `openclaw.extensions` / `openclaw.runtimeExtensions` point
 *    OpenClaw at this module (source vs built JS).
 *  - `openclaw.plugin.json` (plugin root) carries static manifest metadata.
 *
 * ⚠️ TASK 1.2: verify on-device that the engine loads and `api.registerContextEngine`
 * accepts (id, factory). The SDK import path / api method are the single seam
 * to fix if OpenClaw's actual convention differs (see openclaw-sdk.d.ts).
 */

import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { DoctorChaosContextEngine, ENGINE_ID } from './engine.js';
import type { ContextEngineFactoryContext } from './openclaw-types.js';

export { DoctorChaosContextEngine, ENGINE_ID } from './engine.js';
export type * from './openclaw-types.js';

export default definePluginEntry({
  id: ENGINE_ID,
  name: 'Doctor Chaos',
  description:
    'Topic-routing context engine — assembles each turn from its topic space.',
  register(api) {
    api.registerContextEngine(
      ENGINE_ID,
      (ctx: ContextEngineFactoryContext) => new DoctorChaosContextEngine(ctx),
    );
  },
});
