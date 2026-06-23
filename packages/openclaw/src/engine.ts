/**
 * DoctorChaosContextEngine — Doctor Chaos as an OpenClaw context engine.
 *
 * v0.1 scope (this file grows across tasks 2–7):
 *  - Task 1 (now): hello-world skeleton — implements the 4 required methods
 *    with SAFE no-op / pass-through behavior so OpenClaw can load and run the
 *    engine without any behavior change. This is the load-bearing checkpoint
 *    (see spec task 1.2): prove the plugin loads before adding routing logic.
 *  - Task 2–3: message mapping + persistence.
 *  - Task 4: real `ingest` → clinic.send routing.
 *  - Task 5: real `assemble` → topic-space selection.
 *
 * Design invariants (already enforced in the skeleton):
 *  - fail-open: never throw into the OpenClaw runtime.
 *  - assemble pass-through when uncertain (no-worse-than-default).
 */

import type {
  AssembleParams,
  AssembleResult,
  CompactParams,
  CompactResult,
  ContextEngine,
  ContextEngineFactoryContext,
  ContextEngineInfo,
  IngestParams,
  IngestResult,
} from './openclaw-types.js';

export const ENGINE_ID = 'doctor-chaos';

export class DoctorChaosContextEngine implements ContextEngine {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(private readonly factoryCtx: ContextEngineFactoryContext = {}) {}

  readonly info: ContextEngineInfo = {
    id: ENGINE_ID,
    name: 'Doctor Chaos',
    ownsCompaction: true,
  };

  /**
   * Route a message into its topic space. Task 1 skeleton: no-op.
   * Real routing (clinic.send) lands in task 4.
   */
  async ingest(_params: IngestParams): Promise<IngestResult> {
    return { ingested: false };
  }

  /**
   * Select the context for this request. Task 1 skeleton: pass-through —
   * return exactly what the host assembled, so installing the engine is a
   * no-op until task 5 wires topic-space selection.
   */
  async assemble(params: AssembleParams): Promise<AssembleResult> {
    return {
      messages: params.messages,
      estimatedTokens: 0,
    };
  }

  /**
   * Compaction. Doctor Chaos bounds context via topic assembly rather than
   * summarization, so this is intentionally a no-op (see spec Req 4).
   */
  async compact(_params: CompactParams): Promise<CompactResult> {
    return {
      ok: true,
      compacted: false,
      reason: 'doctor-chaos bounds context via topic assembly',
    };
  }
}
