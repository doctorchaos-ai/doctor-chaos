import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DoctorChaosContextEngine } from './engine.js';
import { createLogger } from './logging.js';
import { loadState, sessionSnapshotPath } from './persistence.js';
import type { AgentMessage } from './openclaw-types.js';

// Isolate persistence writes to a temp HOME so tests don't touch ~/.doctorchaos.
let home: string;
let prevHome: string | undefined;
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'dc-home-'));
  prevHome = process.env.HOME;
  process.env.HOME = home;
});
afterAll(async () => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  await rm(home, { recursive: true, force: true });
});

function engine() {
  // silent logger to keep test output clean
  return new DoctorChaosContextEngine({}, createLogger(() => {}));
}

describe('DoctorChaosContextEngine', () => {
  it('exposes the expected info', () => {
    const e = engine();
    expect(e.info).toEqual({ id: 'doctor-chaos', name: 'Doctor Chaos', ownsCompaction: true });
  });

  it('compact is a no-op', async () => {
    const r = await engine().compact({ sessionId: 's' });
    expect(r).toEqual({
      ok: true,
      compacted: false,
      reason: 'doctor-chaos bounds context via topic assembly',
    });
  });

  it('ingest returns ingested:false for empty content', async () => {
    const e = engine();
    const r = await e.ingest({ sessionId: 's-empty', message: { role: 'user', content: '' } });
    expect(r.ingested).toBe(false);
  });

  it('ingest accepts a non-empty message and assemble returns a well-formed result', async () => {
    const e = engine();
    const sid = 's-route';
    const ing = await e.ingest({
      sessionId: sid,
      message: { role: 'user', content: 'tell me about pokemon' },
    });
    expect(ing.ingested).toBe(true);

    const host: AgentMessage[] = [{ role: 'user', content: 'tell me about pokemon' }];
    const res = await e.assemble({
      sessionId: sid,
      messages: host,
      prompt: 'pokemon',
      tokenBudget: 100000,
    });
    // Until a topic space forms, assemble safely passes through; either way
    // the result is well-formed (no throw, array + numeric estimate).
    expect(Array.isArray(res.messages)).toBe(true);
    expect(typeof res.estimatedTokens).toBe('number');
  });

  it('assemble passes through host messages when no space exists yet', async () => {
    const e = engine();
    const host: AgentMessage[] = [{ role: 'user', content: 'first ever message' }];
    const res = await e.assemble({
      sessionId: 's-cold',
      messages: host,
      prompt: 'first ever message',
      tokenBudget: 1000,
    });
    expect(res.messages).toBe(host);
  });

  it('persists clinic state to disk and rehydrates it (Req 8)', async () => {
    const sid = 's-persist';
    const e1 = engine();
    await e1.ingest({ sessionId: sid, message: { role: 'user', content: 'persist me' } });

    // The snapshot file should exist and contain the message (in a space or
    // the inbox), proving state survives across process/engine restarts.
    const state = await loadState(sessionSnapshotPath(sid));
    expect(state).not.toBeNull();
    const texts = [
      ...state!.spaces.flatMap((s) => s.messages.map((m) => m.content)),
      ...state!.inbox.fragments.flatMap((f) => f.messages.map((m) => m.content)),
    ];
    expect(texts).toContain('persist me');

    // A fresh engine instance loads that state without error.
    const e2 = engine();
    const res = await e2.assemble({
      sessionId: sid,
      messages: [{ role: 'user', content: 'x' }],
      prompt: 'persist',
      tokenBudget: 100000,
    });
    expect(Array.isArray(res.messages)).toBe(true);
  });
});
