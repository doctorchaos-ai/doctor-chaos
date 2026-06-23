import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InboxSpace, TopicSpace } from '@doctorchaos-ai/core';
import {
  loadState,
  saveState,
  reviveState,
  sessionSnapshotPath,
  type PersistedState,
} from './persistence.js';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dc-openclaw-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function sampleState(): PersistedState {
  const space: TopicSpace = {
    id: 's1',
    name: 'Pokemon',
    keywords: ['pokemon'],
    createdDate: new Date('2026-06-01T00:00:00.000Z'),
    lastActivityDate: new Date('2026-06-02T00:00:00.000Z'),
    creationSource: 'direct',
    status: 'active',
    messages: [
      { id: 'm1', role: 'user', content: 'hi', timestamp: new Date('2026-06-01T00:00:00.000Z') },
    ],
  } as TopicSpace;
  const inbox: InboxSpace = { id: 'inbox', fragments: [], totalMessageCount: 0 } as InboxSpace;
  return { spaces: [space], inbox };
}

describe('reviveState', () => {
  it('revives Date fields on spaces and messages', () => {
    const json = JSON.stringify(sampleState());
    const revived = reviveState(json);
    expect(revived.spaces[0]!.createdDate).toBeInstanceOf(Date);
    expect(revived.spaces[0]!.lastActivityDate).toBeInstanceOf(Date);
    expect(revived.spaces[0]!.messages[0]!.timestamp).toBeInstanceOf(Date);
    expect(revived.spaces[0]!.lastActivityDate.toISOString()).toBe('2026-06-02T00:00:00.000Z');
  });
  it('throws on malformed JSON / shape', () => {
    expect(() => reviveState('not json')).toThrow();
    expect(() => reviveState('{"spaces": "nope", "inbox": {}}')).toThrow();
  });
});

describe('saveState / loadState', () => {
  it('round-trips through disk', async () => {
    const path = join(dir, 'snap.json');
    await saveState(path, sampleState());
    const loaded = await loadState(path);
    expect(loaded).not.toBeNull();
    expect(loaded!.spaces[0]!.name).toBe('Pokemon');
    expect(loaded!.spaces[0]!.lastActivityDate).toBeInstanceOf(Date);
  });

  it('returns null for a missing file', async () => {
    expect(await loadState(join(dir, 'does-not-exist.json'))).toBeNull();
  });

  it('throws for a malformed file (caller handles fail-soft)', async () => {
    const path = join(dir, 'bad.json');
    await saveState(join(dir, 'placeholder.json'), sampleState());
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, '{ broken', 'utf8');
    await expect(loadState(path)).rejects.toThrow();
  });
});

describe('sessionSnapshotPath', () => {
  it('sanitizes session ids', () => {
    const p = sessionSnapshotPath('agent:telegram/dm:42');
    expect(p).toContain('agent_telegram_dm_42');
    expect(p.endsWith('snapshot.json')).toBe(true);
  });
});
