import { describe, it, expect } from 'vitest';
import type { TopicSpace } from '@doctorchaos-ai/core';
import { chooseSpaceId } from './space-selection.js';

function makeSpace(
  id: string,
  name: string,
  keywords: string[],
  lastActivityMs: number,
): TopicSpace {
  const d = new Date(lastActivityMs);
  return {
    id,
    name,
    keywords,
    createdDate: d,
    lastActivityDate: d,
    creationSource: 'direct',
    status: 'active',
    messages: [],
  } as TopicSpace;
}

describe('chooseSpaceId', () => {
  it('returns null when there are no spaces', () => {
    expect(chooseSpaceId([], 'anything')).toBeNull();
  });

  it('picks the space whose keywords overlap the prompt', () => {
    const spaces = [
      makeSpace('a', 'Pokemon', ['pokemon', 'pikachu'], 1000),
      makeSpace('b', 'Work', ['deadline', 'meeting'], 2000),
    ];
    expect(chooseSpaceId(spaces, 'when is the meeting about the deadline')).toBe('b');
    expect(chooseSpaceId(spaces, 'I caught a pikachu')).toBe('a');
  });

  it('falls back to most recently active when no keyword overlaps', () => {
    const spaces = [
      makeSpace('a', 'Pokemon', ['pokemon'], 1000),
      makeSpace('b', 'Work', ['deadline'], 5000),
    ];
    expect(chooseSpaceId(spaces, 'totally unrelated text')).toBe('b');
  });

  it('uses most recently active when prompt is empty', () => {
    const spaces = [
      makeSpace('a', 'A', ['x'], 1000),
      makeSpace('b', 'B', ['y'], 9000),
    ];
    expect(chooseSpaceId(spaces, '')).toBe('b');
    expect(chooseSpaceId(spaces, undefined)).toBe('b');
  });
});
