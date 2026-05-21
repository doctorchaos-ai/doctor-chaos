import { beforeEach, describe, expect, it } from 'vitest';
import { Clinic } from './clinic.js';
import type { TopicSpace } from './types/topic-space.js';

function sequentialIds(prefix = 'id'): () => string {
  let n = 0;
  return () => {
    n++;
    return `${prefix}-${n}`;
  };
}

function space(
  overrides: Partial<TopicSpace> & Pick<TopicSpace, 'id' | 'name' | 'keywords'>,
): TopicSpace {
  // Default to a seed message containing the keywords so TF-IDF has
  // content to work with. Real spaces always have at least one message.
  const defaultMessages =
    overrides.keywords.length > 0
      ? [
          {
            id: `${overrides.id}-seed`,
            role: 'user' as const,
            content: overrides.keywords.join(' ') + ' ' + overrides.name,
            timestamp: overrides.lastActivityDate ?? new Date('2026-05-07'),
          },
        ]
      : [];
  return {
    id: overrides.id,
    name: overrides.name,
    keywords: overrides.keywords,
    createdDate: overrides.createdDate ?? new Date('2026-01-01'),
    lastActivityDate: overrides.lastActivityDate ?? new Date('2026-05-07'),
    creationSource: overrides.creationSource ?? 'preset',
    status: overrides.status ?? 'active',
    messages: overrides.messages ?? defaultMessages,
  };
}

describe('Clinic.send — routing into spaces', () => {
  it('routes into an existing space when keywords strongly match', async () => {
    const travel = space({
      id: 's-travel',
      name: 'Travel',
      keywords: ['travel', 'flight', 'hotel'],
    });
    const clinic = new Clinic({
      initialSpaces: [travel],
      idGenerator: sequentialIds('m'),
      clock: () => new Date('2026-05-07T12:00:00Z'),
    });
    const result = await clinic.send({
      role: 'user',
      content: 'book a travel flight and hotel for Kyoto',
    });
    expect(result.destination).toBe('topicSpace');
    if (result.destination === 'topicSpace') {
      expect(result.space.id).toBe('s-travel');
      expect(result.isNewSpace).toBe(false);
      // Space has the seed message + the newly routed message.
      expect(result.space.messages).toHaveLength(2);
    }
  });

  it('creates a new space for a substantive unmatched message', async () => {
    const travel = space({
      id: 's-travel',
      name: 'Travel',
      keywords: ['flight', 'hotel', 'passport', 'visa', 'kyoto'],
    });
    const clinic = new Clinic({
      initialSpaces: [travel],
      idGenerator: sequentialIds('m'),
    });
    const result = await clinic.send({
      role: 'user',
      content: "Let's begin planning the kitchen renovation budget in detail today please",
    });
    expect(result.destination).toBe('topicSpace');
    if (result.destination === 'topicSpace') {
      expect(result.isNewSpace).toBe(true);
      expect(result.space.creationSource).toBe('direct');
      expect(result.space.messages).toHaveLength(1);
    }
  });

  it('stashes weak/trivial messages in the inbox as a new fragment', async () => {
    const clinic = new Clinic({ idGenerator: sequentialIds('m') });
    const result = await clinic.send({
      role: 'user',
      content: "what's the weather",
    });
    expect(result.destination).toBe('inbox');
    if (result.destination === 'inbox') {
      expect(result.inbox.fragments).toHaveLength(1);
      expect(result.fragment.messages).toHaveLength(1);
    }
  });

  it('assigns ids and timestamps when the input omits them', async () => {
    const clinic = new Clinic({
      idGenerator: sequentialIds('gen'),
      clock: () => new Date('2026-05-07T12:00:00Z'),
    });
    const result = await clinic.send({ role: 'user', content: 'hi' });
    expect(result.message.id).toBe('gen-1'); // first id consumed by the message
    expect(result.message.timestamp).toEqual(new Date('2026-05-07T12:00:00Z'));
  });

  it('provides decision.reasoning on every call', async () => {
    const clinic = new Clinic({ idGenerator: sequentialIds() });
    const result = await clinic.send({ role: 'user', content: 'hi' });
    expect(result.decision.reasoning.length).toBeGreaterThan(0);
  });
});

describe('Clinic.spaces / inbox / space', () => {
  it('exposes spaces filtered by status', async () => {
    const active = space({ id: 'a', name: 'A', keywords: [], status: 'active' });
    const archived = space({ id: 'b', name: 'B', keywords: [], status: 'archived' });
    const clinic = new Clinic({ initialSpaces: [active, archived] });
    expect(clinic.spaces()).toHaveLength(2);
    expect(clinic.spaces({ status: 'active' })).toEqual([active]);
    expect(clinic.spaces({ status: ['archived'] })).toEqual([archived]);
  });

  it('looks up a single space by id', () => {
    const travel = space({ id: 't', name: 'T', keywords: [] });
    const clinic = new Clinic({ initialSpaces: [travel] });
    expect(clinic.space('t')).toEqual(travel);
    expect(clinic.space('unknown')).toBeUndefined();
  });

  it('returns the current inbox', () => {
    const clinic = new Clinic();
    expect(clinic.inbox().fragments).toEqual([]);
  });
});

describe('Clinic.moveMessage', () => {
  let clinic: Clinic;
  let messageId: string;

  beforeEach(async () => {
    clinic = new Clinic({ idGenerator: sequentialIds('id') });
    const res = await clinic.send({ role: 'user', content: 'what is the weather' });
    if (res.destination !== 'inbox') throw new Error('expected weather to land in inbox');
    messageId = res.message.id;
  });

  it('moves a message from inbox to a topic space', async () => {
    // Seed a target space.
    const seed = await clinic.send({
      role: 'user',
      content: 'planning a travel itinerary for Kyoto next spring please',
    });
    if (seed.destination !== 'topicSpace') throw new Error('expected a topic space');
    const targetId = seed.space.id;

    const updated = await clinic.moveMessage(messageId, targetId);
    expect(updated.messages.map((m) => m.id)).toContain(messageId);
    expect(clinic.inbox().fragments).toHaveLength(0);
  });

  it('throws for an unknown target space', async () => {
    await expect(clinic.moveMessage(messageId, 'not-a-real-id')).rejects.toThrow(/unknown target/);
  });

  it('throws for an unknown message id', async () => {
    const seed = await clinic.send({
      role: 'user',
      content: 'planning a travel itinerary for Kyoto next spring please',
    });
    if (seed.destination !== 'topicSpace') throw new Error('expected a topic space');
    await expect(clinic.moveMessage('ghost-id', seed.space.id)).rejects.toThrow(/unknown message/);
  });

  it('records a correction in the snapshot after moving', async () => {
    const seed = await clinic.send({
      role: 'user',
      content: 'planning a travel itinerary for Kyoto next spring please',
    });
    if (seed.destination !== 'topicSpace') throw new Error('expected topic space');
    await clinic.moveMessage(messageId, seed.space.id);
    const snap = clinic.snapshot();
    expect(snap.corrections.length).toBe(1);
    expect(snap.corrections[0]!.correctedDestination).toBe(seed.space.id);
  });
});

describe('Clinic.checkPackaging', () => {
  it('creates no new spaces when clusters are below threshold', async () => {
    const clinic = new Clinic({ idGenerator: sequentialIds() });
    await clinic.send({ role: 'user', content: 'weather today' });
    await clinic.send({ role: 'user', content: 'weather tomorrow' });
    const created = await clinic.checkPackaging();
    // default threshold is 3 fragments; only 2 inbox items here.
    expect(created).toEqual([]);
  });

  it('packages a dense cluster into a new topic space', async () => {
    const clinic = new Clinic({ idGenerator: sequentialIds() });
    // Three weather-trivia messages → all go to inbox, share 'weather' bigram/token.
    await clinic.send({ role: 'user', content: 'weather today report' });
    await clinic.send({ role: 'user', content: 'weather tomorrow forecast' });
    await clinic.send({ role: 'user', content: 'weather next week outlook' });
    const created = await clinic.checkPackaging();
    expect(created.length).toBeGreaterThanOrEqual(1);
    expect(clinic.inbox().fragments).toHaveLength(0);
  });
});

describe('Clinic.checkLifecycle', () => {
  it('archives spaces past the inactivity threshold', async () => {
    const veryOld = space({
      id: 'stale',
      name: 'Stale',
      keywords: [],
      status: 'active',
      lastActivityDate: new Date('2020-01-01'),
    });
    const clinic = new Clinic({ initialSpaces: [veryOld] });
    const changed = await clinic.checkLifecycle();
    expect(changed).toHaveLength(1);
    expect(changed[0]!.status).toBe('archived');
    expect(clinic.space('stale')!.status).toBe('archived');
  });
});

describe('Clinic.snapshot', () => {
  it('returns the full in-memory state for persistence', async () => {
    const clinic = new Clinic({ idGenerator: sequentialIds('id') });
    await clinic.send({ role: 'user', content: 'travel to Kyoto please' });
    const snap = clinic.snapshot();
    expect(snap.spaces.length + snap.inbox.fragments.length).toBeGreaterThan(0);
    expect(Array.isArray(snap.corrections)).toBe(true);
  });
});
