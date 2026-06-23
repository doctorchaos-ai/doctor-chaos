/**
 * Build the request context for a turn (Req 3): select the relevant topic
 * space, return its history trimmed to the token budget, mapped back to
 * OpenClaw messages.
 *
 * Pure given the current spaces — easy to unit-test without a live Clinic.
 * Pass-through (return the host's assembled messages) when there is no space
 * to select, preserving the no-worse-than-default property (Req 3.4).
 */

import type { Message, TopicSpace } from '@doctorchaos-ai/core';
import type { AgentMessage, AssembleResult } from './openclaw-types.js';
import { toAgentMessage } from './message-mapping.js';
import { chooseSpaceId } from './space-selection.js';

/** Rough token estimate (~4 chars/token), good enough for budgeting. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function messagesTokens(messages: readonly { content: string }[]): number {
  let total = 0;
  for (const m of messages) total += estimateTokens(m.content);
  return total;
}

/**
 * Keep the most recent messages whose cumulative estimate fits `budget`.
 * Returns messages in chronological order. A falsy budget keeps everything.
 */
export function tailTrim<T extends { content: string }>(
  messages: readonly T[],
  budget: number | undefined,
): T[] {
  if (!budget || budget <= 0) return [...messages];
  const kept: T[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    const cost = estimateTokens(m.content);
    if (used + cost > budget && kept.length > 0) break;
    kept.push(m);
    used += cost;
  }
  kept.reverse();
  return kept;
}

/**
 * Assemble the request context from the current spaces.
 *
 * @param spaces        current topic spaces (from `clinic.spaces()`)
 * @param prompt        the incoming user prompt for this turn
 * @param hostMessages  the messages OpenClaw assembled (pass-through fallback)
 * @param tokenBudget   model context budget, if known
 */
export function assembleContext(
  spaces: readonly TopicSpace[],
  prompt: string | undefined,
  hostMessages: AgentMessage[],
  tokenBudget: number | undefined,
): AssembleResult {
  const spaceId = chooseSpaceId(spaces, prompt);
  if (spaceId === null) {
    // No topic space yet (cold start / inbox only) — defer to the host.
    return passThrough(hostMessages);
  }

  const space = spaces.find((s) => s.id === spaceId);
  if (!space || space.messages.length === 0) {
    return passThrough(hostMessages);
  }

  const trimmed: Message[] = tailTrim(space.messages, tokenBudget);
  const messages = trimmed.map((m) => toAgentMessage({ role: m.role, content: m.content }));
  return {
    messages,
    estimatedTokens: messagesTokens(trimmed),
  };
}

function passThrough(hostMessages: AgentMessage[]): AssembleResult {
  let est = 0;
  for (const m of hostMessages) {
    if (typeof m.content === 'string') est += estimateTokens(m.content);
  }
  return { messages: hostMessages, estimatedTokens: est };
}
