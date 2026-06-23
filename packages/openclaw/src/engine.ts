/**
 * DoctorChaosContextEngine — Doctor Chaos as an OpenClaw context engine.
 *
 * v0.1 behavior:
 *  - ingest      → route the message into its topic space (clinic.send).
 *  - assemble    → select the relevant space and return its history (trimmed
 *                  to budget) as this turn's context; pass-through when there
 *                  is no space yet or on any error.
 *  - compact     → no-op (Doctor Chaos bounds context via topic assembly).
 *  - afterTurn   → opportunistic packaging/lifecycle maintenance + persist.
 *  - bootstrap   → warm the per-session Clinic from disk.
 *
 * Invariants:
 *  - fail-open: no method throws into the OpenClaw runtime (Req 7).
 *  - assemble pass-through preserves no-worse-than-default (Req 3.4/3.5).
 *  - one Clinic per sessionId, persisted under ~/.doctorchaos/openclaw/.
 *
 * core (@doctorchaos-ai/core) is bundled into this plugin's dist, so no
 * separate core install is needed on the host.
 */

import { Clinic } from '@doctorchaos-ai/core';
import type {
  AfterTurnParams,
  AssembleParams,
  AssembleResult,
  BootstrapParams,
  BootstrapResult,
  CompactParams,
  CompactResult,
  ContextEngine,
  ContextEngineFactoryContext,
  ContextEngineInfo,
  IngestParams,
  IngestResult,
} from './openclaw-types.js';
import { toClinicInput } from './message-mapping.js';
import { assembleContext } from './assemble.js';
import { loadState, saveState, sessionSnapshotPath } from './persistence.js';
import { createLogger, type PluginLogger } from './logging.js';

export const ENGINE_ID = 'doctor-chaos';

export class DoctorChaosContextEngine implements ContextEngine {
  private readonly clinics = new Map<string, Promise<Clinic>>();
  private readonly logger: PluginLogger;

  constructor(
    private readonly factoryCtx: ContextEngineFactoryContext = {},
    logger?: PluginLogger,
  ) {
    this.logger = logger ?? createLogger();
  }

  readonly info: ContextEngineInfo = {
    id: ENGINE_ID,
    name: 'Doctor Chaos',
    ownsCompaction: true,
  };

  async bootstrap(params: BootstrapParams): Promise<BootstrapResult> {
    try {
      await this.ensureClinic(params.sessionId);
      return { bootstrapped: true };
    } catch (err) {
      this.logger.warn('bootstrap failed; starting empty', err);
      return { bootstrapped: false, reason: 'load failed' };
    }
  }

  async ingest(params: IngestParams): Promise<IngestResult> {
    try {
      const input = toClinicInput(params.message);
      if (input === null) return { ingested: false };
      const clinic = await this.ensureClinic(params.sessionId);
      await clinic.send(input);
      await this.save(params.sessionId, clinic);
      this.logger.recover(`ingest:${params.sessionId}`);
      return { ingested: true };
    } catch (err) {
      this.logger.warnOnce(`ingest:${params.sessionId}`, 'ingest failed; skipping', err);
      return { ingested: false };
    }
  }

  async assemble(params: AssembleParams): Promise<AssembleResult> {
    try {
      const clinic = await this.ensureClinic(params.sessionId);
      const result = assembleContext(
        clinic.spaces(),
        params.prompt,
        params.messages,
        params.tokenBudget,
      );
      this.logger.recover(`assemble:${params.sessionId}`);
      return result;
    } catch (err) {
      this.logger.warnOnce(
        `assemble:${params.sessionId}`,
        'assemble failed; passing through host messages',
        err,
      );
      // no-worse-than-default: hand back exactly what the host assembled.
      return { messages: params.messages, estimatedTokens: 0 };
    }
  }

  async compact(_params: CompactParams): Promise<CompactResult> {
    return {
      ok: true,
      compacted: false,
      reason: 'doctor-chaos bounds context via topic assembly',
    };
  }

  async afterTurn(params: AfterTurnParams): Promise<void> {
    try {
      const clinic = await this.ensureClinic(params.sessionId);
      await clinic.checkPackaging();
      await clinic.checkLifecycle();
      await this.save(params.sessionId, clinic);
    } catch (err) {
      this.logger.warnOnce(
        `afterTurn:${params.sessionId}`,
        'afterTurn maintenance failed',
        err,
      );
    }
  }

  // ─── internals ──────────────────────────────────────────────────────

  private ensureClinic(sessionId: string): Promise<Clinic> {
    const existing = this.clinics.get(sessionId);
    if (existing) return existing;
    const created = this.loadClinic(sessionId);
    this.clinics.set(sessionId, created);
    return created;
  }

  private async loadClinic(sessionId: string): Promise<Clinic> {
    const path = sessionSnapshotPath(sessionId);
    let state = null;
    try {
      state = await loadState(path);
      this.logger.recover(`load:${sessionId}`);
    } catch (err) {
      // Malformed snapshot — start empty rather than crash (Req 8.3).
      this.logger.warnOnce(`load:${sessionId}`, 'snapshot unreadable; starting empty', err);
      state = null;
    }
    if (state === null) {
      return new Clinic({ autoDetectOpenAI: false });
    }
    return new Clinic({
      initialSpaces: state.spaces,
      initialInbox: state.inbox,
      autoDetectOpenAI: false,
    });
  }

  private async save(sessionId: string, clinic: Clinic): Promise<void> {
    try {
      const snap = clinic.snapshot();
      await saveState(sessionSnapshotPath(sessionId), {
        spaces: [...snap.spaces],
        inbox: snap.inbox,
      });
      this.logger.recover(`save:${sessionId}`);
    } catch (err) {
      this.logger.warnOnce(`save:${sessionId}`, 'failed to persist snapshot', err);
    }
  }
}
