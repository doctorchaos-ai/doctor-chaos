import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deserializeSnapshot,
  loadSnapshot,
  serializeSnapshot,
  writeSnapshot,
  type ClinicSnapshot,
} from './persistence.js';

/**
 * Persistence tests — the hot spot for Risk R6.
 *
 * These tests specifically exist to catch the class of bug where a
 * `Date` field survives serialization but does not round-trip on load
 * (becomes a string, or worse, a string-looking-like-a-Date that
 * breaks downstream `.getTime()` calls).
 */

function sampleSnapshot(): ClinicSnapshot {
  return {
    spaces: [
      {
        id: 'space-1',
        name: '京都周末行',
        keywords: ['京都', '周末', '日本'],
        createdDate: new Date('2026-05-01T08:00:00.000Z'),
        lastActivityDate: new Date('2026-05-10T14:30:00.000Z'),
        creationSource: 'direct',
        status: 'active',
        contextSummary: '一次还没敲定的周末短途。',
        messages: [
          {
            id: 'msg-1',
            role: 'user',
            content: '帮我想想京都周末怎么玩',
            timestamp: new Date('2026-05-01T08:00:00.000Z'),
            routing: {
              originalDestination: 'space-1',
              confidence: 0.92,
              wasReassigned: false,
            },
          },
          {
            id: 'msg-2',
            role: 'assistant',
            content: '先列几个候选景点：...',
            timestamp: new Date('2026-05-01T08:00:05.000Z'),
          },
        ],
      },
    ],
    inbox: {
      id: 'inbox',
      fragments: [
        {
          id: 'frag-1',
          timestamp: new Date('2026-05-11T09:00:00.000Z'),
          keywords: ['天气'],
          clusterHint: 'utility',
          messages: [
            {
              id: 'msg-3',
              role: 'user',
              content: '今天天气怎么样',
              timestamp: new Date('2026-05-11T09:00:00.000Z'),
            },
          ],
        },
      ],
      totalMessageCount: 1,
    },
    corrections: [
      {
        id: 'corr-1',
        messageId: 'msg-3',
        originalDestination: 'inbox',
        correctedDestination: 'space-1',
        timestamp: new Date('2026-05-11T10:00:00.000Z'),
        messageContent: '今天天气怎么样',
      },
    ],
  };
}

function expectDatesEqual(a: Date, b: Date): void {
  expect(a).toBeInstanceOf(Date);
  expect(b).toBeInstanceOf(Date);
  expect(a.getTime()).toBe(b.getTime());
}

describe('serializeSnapshot + deserializeSnapshot', () => {
  it('round-trips every Date field as a real Date instance', () => {
    const original = sampleSnapshot();
    const revived = deserializeSnapshot(serializeSnapshot(original));

    // Top-level shape preserved.
    expect(revived.spaces).toHaveLength(1);
    expect(revived.corrections).toHaveLength(1);
    expect(revived.inbox.fragments).toHaveLength(1);

    // Dates are Dates, not strings.
    const space = revived.spaces[0]!;
    const originalSpace = original.spaces[0]!;
    expectDatesEqual(space.createdDate, originalSpace.createdDate);
    expectDatesEqual(space.lastActivityDate, originalSpace.lastActivityDate);

    for (let i = 0; i < space.messages.length; i++) {
      expectDatesEqual(space.messages[i]!.timestamp, originalSpace.messages[i]!.timestamp);
    }

    const fragment = revived.inbox.fragments[0]!;
    const originalFragment = original.inbox.fragments[0]!;
    expectDatesEqual(fragment.timestamp, originalFragment.timestamp);
    expectDatesEqual(fragment.messages[0]!.timestamp, originalFragment.messages[0]!.timestamp);

    expectDatesEqual(revived.corrections[0]!.timestamp, original.corrections[0]!.timestamp);
  });

  it('preserves non-date fields exactly', () => {
    const original = sampleSnapshot();
    const revived = deserializeSnapshot(serializeSnapshot(original));

    expect(revived.spaces[0]?.name).toBe('京都周末行');
    expect(revived.spaces[0]?.keywords).toEqual(['京都', '周末', '日本']);
    expect(revived.spaces[0]?.contextSummary).toBe('一次还没敲定的周末短途。');
    expect(revived.spaces[0]?.messages[0]?.routing?.confidence).toBe(0.92);
    expect(revived.spaces[0]?.messages[0]?.routing?.wasReassigned).toBe(false);
    expect(revived.inbox.fragments[0]?.clusterHint).toBe('utility');
    expect(revived.inbox.totalMessageCount).toBe(1);
    expect(revived.corrections[0]?.messageContent).toBe('今天天气怎么样');
  });

  it('throws with a clear message on a missing required date', () => {
    const broken = {
      spaces: [
        {
          id: 's',
          name: 'n',
          keywords: [],
          // createdDate missing
          lastActivityDate: new Date().toISOString(),
          creationSource: 'direct',
          status: 'active',
          messages: [],
        },
      ],
      inbox: { id: 'inbox', fragments: [], totalMessageCount: 0 },
      corrections: [],
    };
    expect(() => deserializeSnapshot(JSON.stringify(broken))).toThrow(
      /topicSpace\.createdDate/,
    );
  });

  it('throws with a clear message on malformed JSON', () => {
    expect(() => deserializeSnapshot('{not json')).toThrow(/failed to parse/);
  });
});

describe('writeSnapshot + loadSnapshot', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'doctor-chaos-persistence-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('round-trips through disk atomically', async () => {
    const path = join(tmp, 'nested', 'snapshot.json');
    const original = sampleSnapshot();
    await writeSnapshot(path, original);

    const loaded = await loadSnapshot(path);
    expect(loaded).not.toBeNull();
    expect(loaded!.spaces[0]?.name).toBe('京都周末行');
    expectDatesEqual(
      loaded!.spaces[0]!.createdDate,
      original.spaces[0]!.createdDate,
    );
  });

  it('returns null when the snapshot file does not exist', async () => {
    const loaded = await loadSnapshot(join(tmp, 'absent.json'));
    expect(loaded).toBeNull();
  });

  it('throws when the snapshot file is unreadable JSON', async () => {
    const path = join(tmp, 'broken.json');
    await writeFile(path, '{not valid', 'utf8');
    await expect(loadSnapshot(path)).rejects.toThrow(/failed to parse/);
  });
});
