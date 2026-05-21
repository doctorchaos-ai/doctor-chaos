import { describe, expect, it } from 'vitest';
import { defaultRoutingConfiguration } from '../config/routing-configuration.js';
import type { Fragment } from '../types/fragment.js';
import type { Message } from '../types/message.js';
import type { TopicSpace } from '../types/topic-space.js';
import { RoutingEngine } from './routing-engine.js';

const NOW = new Date('2026-05-07T12:00:00Z');

function space(
  id: string,
  name: string,
  keywords: string[],
  lastActivityDate: Date = NOW,
  status: TopicSpace['status'] = 'active',
): TopicSpace {
  // Include a seed message containing the keywords so TF-IDF has
  // content to build a document vector from. Real spaces always have
  // at least one message (the one that created them).
  const seedMsg: Message = {
    id: `${id}-seed`,
    role: 'user',
    content: keywords.join(' ') + ' ' + name,
    timestamp: lastActivityDate,
  };
  return {
    id,
    name,
    keywords,
    createdDate: new Date('2026-01-01'),
    lastActivityDate,
    creationSource: 'preset',
    status,
    messages: [seedMsg],
  };
}

function inboxFragment(id: string, keywords: string[]): Fragment {
  const msg: Message = { id: `${id}-m`, role: 'user', content: keywords.join(' '), timestamp: NOW };
  return { id, messages: [msg], timestamp: NOW, keywords };
}

describe('RoutingEngine — signal handling', () => {
  it('routes a strong-cue message to the best-matching active space', async () => {
    const engine = new RoutingEngine();
    const travel = space('travel', 'Travel 2026', ['travel', 'flight', 'kyoto']);
    const renovation = space('reno', 'Home renovation', ['tile', 'paint', 'floor']);

    const decision = await engine.route(
      'continuing the travel conversation about Kyoto',
      [travel, renovation],
      [],
      NOW,
    );

    expect(decision.destination).toEqual({ kind: 'existingTopicSpace', topicSpace: travel });
    expect(decision.confidence).toBeGreaterThan(0.9);
  });

  it('falls back to inbox on strong signal when no active spaces exist', async () => {
    const engine = new RoutingEngine();
    const decision = await engine.route('接着上次说的', [], [], NOW);
    expect(decision.destination).toEqual({ kind: 'inbox' });
    expect(decision.confidence).toBeLessThanOrEqual(0.5);
  });

  it('routes a trivial-cue message to the inbox', async () => {
    const engine = new RoutingEngine();
    const travel = space('travel', 'Travel', ['travel']);
    const decision = await engine.route("what's the weather today?", [travel], [], NOW);
    expect(decision.destination).toEqual({ kind: 'inbox' });
    expect(decision.reasoning).toMatch(/[Tt]rivial/);
  });

  it('routes a weak-cue message to the inbox', async () => {
    const engine = new RoutingEngine();
    const decision = await engine.route('just curious about something', [], [], NOW);
    expect(decision.destination).toEqual({ kind: 'inbox' });
    expect(decision.reasoning).toMatch(/[Ww]eak/);
  });
});

describe('RoutingEngine — normal-signal similarity path', () => {
  it('routes to the best-scoring active space above threshold', async () => {
    const engine = new RoutingEngine();
    const travel = space('travel', 'Travel', ['travel', 'flight', 'hotel']);
    // A message where all three keywords land → relevance 1.0,
    // well above the default 0.6 threshold.
    const decision = await engine.route(
      'I need to plan a travel flight and hotel itinerary',
      [travel],
      [],
      NOW,
    );
    expect(decision.destination).toEqual({ kind: 'existingTopicSpace', topicSpace: travel });
    expect(decision.confidence).toBeGreaterThanOrEqual(
      defaultRoutingConfiguration.confidenceThreshold,
    );
  });

  it('parks the message in the inbox when every active space is a poor match', async () => {
    const engine = new RoutingEngine();
    const travel = space('travel', 'Travel', ['flight', 'hotel', 'passport']);
    // Short, low-overlap message — below threshold and not new-topic-worthy.
    const decision = await engine.route('pasta recipe', [travel], [], NOW);
    expect(decision.destination).toEqual({ kind: 'inbox' });
  });

  it('suggests a brand-new space for a substantive, unmatched message', async () => {
    const engine = new RoutingEngine();
    const travel = space('travel', 'Travel', ['flight', 'hotel', 'passport', 'visa', 'kyoto']);
    const msg = 'Let us start planning the kitchen renovation budget in detail today please';
    const decision = await engine.route(msg, [travel], [], NOW);
    expect(decision.destination.kind).toBe('newTopicSpace');
    if (decision.destination.kind === 'newTopicSpace') {
      expect(decision.destination.suggestedName.length).toBeGreaterThan(0);
    }
  });

  it('prefers recent spaces over stale ones when keyword matches are equal', async () => {
    const engine = new RoutingEngine();
    const recent = space(
      'recent',
      'Recent travel',
      ['travel'],
      new Date(NOW.getTime() - 60 * 1000),
    );
    const stale = space(
      'stale',
      'Stale travel',
      ['travel'],
      new Date(NOW.getTime() - 1000 * 60 * 60 * 24 * 90), // 90 days ago
    );
    const decision = await engine.route('travel plans for Q3', [recent, stale], [], NOW);
    expect(decision.destination).toEqual({ kind: 'existingTopicSpace', topicSpace: recent });
  });

  it('ignores non-active spaces entirely', async () => {
    const engine = new RoutingEngine();
    const archived = space('old', 'Old travel', ['travel', 'flight'], NOW, 'archived');
    const decision = await engine.route('travel flight', [archived], [], NOW);
    // archived → not considered → falls to inbox or new
    expect(decision.destination.kind).not.toBe('existingTopicSpace');
  });
});

describe('RoutingEngine — extras', () => {
  it('is deterministic: identical inputs yield identical outputs', async () => {
    const engine = new RoutingEngine();
    const travel = space('travel', 'Travel', ['travel', 'flight']);
    const a = await engine.route('travel flight booking', [travel], [], NOW);
    const b = await engine.route('travel flight booking', [travel], [], NOW);
    expect(a).toEqual(b);
  });

  it('accepts inbox fragments in the signature without using them yet', async () => {
    const engine = new RoutingEngine();
    const travel = space('travel', 'Travel', ['travel']);
    const fragments = [inboxFragment('f1', ['weather']), inboxFragment('f2', ['jokes'])];
    // Current strategies ignore inboxFragments but the signature accepts them.
    await expect(engine.route('travel plans', [travel], fragments, NOW)).resolves.toBeDefined();
  });

  it('populates reasoning on every decision for observability', async () => {
    const engine = new RoutingEngine();
    const decision = await engine.route('hello', [], [], NOW);
    expect(decision.reasoning.length).toBeGreaterThan(0);
  });
});
