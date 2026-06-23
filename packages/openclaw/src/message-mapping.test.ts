import { describe, it, expect } from 'vitest';
import {
  toClinicRole,
  extractText,
  toClinicInput,
  toAgentMessage,
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
