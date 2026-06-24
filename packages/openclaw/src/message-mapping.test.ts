import { describe, it, expect } from 'vitest';
import {
  toClinicRole,
  extractText,
  toClinicInput,
  toAgentMessage,
  stripConversationWrapper,
} from './message-mapping.js';

describe('toClinicRole', () => {
  it('keeps assistant and system', () => {
    expect(toClinicRole('assistant')).toBe('assistant');
    expect(toClinicRole('system')).toBe('system');
  });
  it('coerces user / tool / unknown to user', () => {
    expect(toClinicRole('user')).toBe('user');
    expect(toClinicRole('tool')).toBe('user');
    expect(toClinicRole('function')).toBe('user');
    expect(toClinicRole(undefined)).toBe('user');
  });
});

describe('extractText', () => {
  it('returns trimmed string content', () => {
    expect(extractText('  hello  ')).toBe('hello');
  });
  it('returns null for empty/whitespace string', () => {
    expect(extractText('')).toBeNull();
    expect(extractText('   ')).toBeNull();
  });
  it('joins text parts from a multimodal array, skipping non-text', () => {
    const content = [
      { type: 'text', text: 'first' },
      { type: 'image_url', image_url: { url: 'http://x' } },
      { type: 'text', text: 'second' },
    ];
    expect(extractText(content)).toBe('first\nsecond');
  });
  it('handles array of bare strings', () => {
    expect(extractText(['a', '  ', 'b'])).toBe('a\nb');
  });
  it('returns null for an array with no text', () => {
    expect(extractText([{ type: 'image_url' }])).toBeNull();
  });
  it('extracts .text from a plain object', () => {
    expect(extractText({ text: 'hi' })).toBe('hi');
  });
  it('returns null for unmappable objects / nullish', () => {
    expect(extractText({ foo: 'bar' })).toBeNull();
    expect(extractText(null)).toBeNull();
    expect(extractText(undefined)).toBeNull();
    expect(extractText(42)).toBeNull();
  });
});

describe('toClinicInput', () => {
  it('maps a plain text user message', () => {
    expect(toClinicInput({ role: 'user', content: 'hello' })).toEqual({
      role: 'user',
      content: 'hello',
    });
  });
  it('maps assistant role and multimodal content', () => {
    const m = {
      role: 'assistant',
      content: [{ type: 'text', text: 'answer' }],
    };
    expect(toClinicInput(m)).toEqual({ role: 'assistant', content: 'answer' });
  });
  it('returns null when there is no routable text', () => {
    expect(toClinicInput({ role: 'user', content: '' })).toBeNull();
    expect(toClinicInput({ role: 'tool', content: [{ type: 'image_url' }] })).toBeNull();
  });
});

describe('stripConversationWrapper', () => {
  const wrapped = [
    'Conversation info (untrusted metadata):',
    '```json',
    '{ "chat_id": "telegram:8559436688", "message_id": "83" }',
    '```',
    '',
    'Sender (untrusted metadata):',
    '```json',
    '{ "name": "chaos xue" }',
    '```',
    '',
    'Conversation context (untrusted, chronological, selected for current message):',
    '#82 Tue 2026-06-23 20:46:01 GMT+8 OpenClaw: 晚上好',
    '#83 Wed 2026-06-24 09:59:48 GMT+8 chaos xue: 还在吗',
    '',
    '为什么超梦这么火',
  ].join('\n');

  it('keeps only the trailing real utterance', () => {
    expect(stripConversationWrapper(wrapped)).toBe('为什么超梦这么火');
  });

  it('returns text unchanged when no wrapper marker is present', () => {
    expect(stripConversationWrapper('just a normal message')).toBe('just a normal message');
  });

  it('falls back to original when extraction would be empty', () => {
    const noTail = [
      'Conversation context (untrusted, chronological, selected for current message):',
      '#1 ... chaos: hi',
    ].join('\n');
    // No trailing message after the entry -> keep original (don't lose content).
    expect(stripConversationWrapper(noTail)).toBe(noTail);
  });
});

describe('toClinicInput with wrapper', () => {
  it('routes on the clean utterance, not the metadata blob', () => {
    const wrapped =
      'Conversation info (untrusted metadata):\n```json\n{"chat_id":"x"}\n```\n\n' +
      'Conversation context (untrusted, chronological, selected for current message):\n' +
      '#1 a: old\n\n人气最高的宝可梦是谁';
    const input = toClinicInput({ role: 'user', content: wrapped });
    expect(input).toEqual({ role: 'user', content: '人气最高的宝可梦是谁' });
  });
});

describe('toAgentMessage', () => {
  it('maps role + content back to an AgentMessage', () => {
    expect(toAgentMessage({ role: 'assistant', content: 'x' })).toEqual({
      role: 'assistant',
      content: 'x',
    });
  });
});

describe('round-trip (text messages)', () => {
  it('preserves role and content for plain text', () => {
    const original = { role: 'assistant', content: 'round trip' };
    const clinic = toClinicInput(original)!;
    const back = toAgentMessage(clinic);
    expect(back.role).toBe(original.role);
    expect(back.content).toBe(original.content);
  });
});
