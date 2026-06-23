import { describe, it, expect } from 'vitest';
import type { Message, TopicSpace } from '@doctorchaos-ai/core';
import { assembleContext, estimateTokens, tailTrim } from './assemble.js';
import type { AgentMessage } from './openclaw-types.js';

function msg(id: string, role: 'user' | 'assistant', content: string): Message {
  return { id, role, content, timestamp: new Date(1000) } as Message;
}

function space(id: string, messages: Message[]): TopicSpace {
  return {
    id,
    name: id,
    keywords: [id],
    createdDate: new Date(1000),
    lastActivityDate: new Date(2000),
    creationSource: 'direct',
    status: 'active',
    messages,
  } as TopicSpace;
}

const HOST: AgentMessage[] = [{ role: 'user', content: 'host message' }];

describe('estimateTokens / tailTrim', () => {
  it('estimates ~4 chars per token', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });
  it('keeps everything when budget is falsy', () => {
    const m = [msg('1', 'user', 'aaaa'), msg('2', 'user', 'bbbb')];
    expect(tailTrim(m, 0)).toHaveLength(2);
    expect(tailTrim(m, undefined)).toHaveLength(2);
  });
  it('keeps the most recent messages within budget, in order', () => {
    const m = [
      msg('1', 'user', 'aaaaaaaa'), // 2 tokens
      msg('2', 'user', 'bbbbbbbb'), // 2 tokens
      msg('3', 'user', 'cccccccc'), // 2 tokens
    ];
    const kept = tailTrim(m, 4); // room for ~2 messages
    expect(kept.map((x) => x.id)).toEqual(['2', '3']);
  });
  it('always keeps at least the last message even if over budget', () => {
    const m = [msg('1', 'user', 'x'.repeat(100))];
    expect(tailTrim(m, 1)).toHaveLength(1);
  });
});

describe('assembleContext', () => {
  it('pass-through when there are no spaces', () => {
    const r = assembleContext([], 'hi', HOST, 1000);
    expect(r.messages).toBe(HOST);
  });

  it('returns the selected space history mapped to AgentMessages', () => {
    const s = space('pokemon', [msg('1', 'user', 'about pokemon'), msg('2', 'assistant', 'yes')]);
    const r = assembleContext([s], 'pokemon please', HOST, 1000);
    expect(r.messages).toEqual([
      { role: 'user', content: 'about pokemon' },
      { role: 'assistant', content: 'yes' },
    ]);
    expect(r.estimatedTokens).toBeGreaterThan(0);
  });

  it('respects the token budget (Property 5)', () => {
    const big = Array.from({ length: 20 }, (_, i) => msg(String(i), 'user', 'x'.repeat(40)));
    const s = space('a', big);
    const budget = 30;
    const r = assembleContext([s], 'a', HOST, budget);
    const est = r.messages.reduce(
      (acc, m) => acc + estimateTokens(typeof m.content === 'string' ? m.content : ''),
      0,
    );
    expect(est).toBeLessThanOrEqual(budget);
    expect(r.messages.length).toBeLessThan(big.length);
  });

  it('pass-through when the chosen space has no messages', () => {
    const s = space('empty', []);
    const r = assembleContext([s], 'empty', HOST, 1000);
    expect(r.messages).toBe(HOST);
  });
});
