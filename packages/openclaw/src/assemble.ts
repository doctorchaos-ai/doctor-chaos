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
 * CRITICAL invariant: the current turn's live tail (the user's actual question)
 * MUST be preserved. At assemble time the current message is NOT yet in any
 * space — ingestion runs in `afterTurn`, AFTER assemble — so a topic space only
 * holds prior turns. Returning space history alone would drop the current
 * question and make the model re-answer an old one (or not answer). We therefore
 * inject the relevant topic history as a PREFIX and always append the host's
 * current turn so the model sees the real question last.
 *
 * @param spaces        current topic spaces (from `clinic.spaces()`)
 * @param prompt        the incoming user prompt for this turn
 * @param hostMessages  the messages OpenClaw assembled (live; ends with the turn)
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
    return passThrough(hostMessages); // cold start / inbox only — defer to host
  }

  const space = spaces.find((s) => s.id === spaceId);
  if (!space || space.messages.length === 0) {
    return passThrough(hostMessages);
  }

  // Always keep the current turn (the host's live tail), so the model sees the
  // actual question — it isn't in the space yet (ingest runs in afterTurn).
  const currentTail = currentTurnTail(hostMessages);
  const reserve = agentMessagesTokens(currentTail);

  let history: Message[];
  if (!tokenBudget || tokenBudget <= 0) {
    history = [...space.messages];
  } else {
    const historyBudget = tokenBudget - reserve;
    history = historyBudget > 0 ? tailTrim(space.messages, historyBudget) : [];
  }

  const messages: AgentMessage[] = [
    ...history.map((m) => toAgentMessage({ role: m.role, content: m.content })),
    ...currentTail,
  ];
  return {
    messages,
    estimatedTokens: messagesTokens(history) + reserve,
  };
}

/**
 * The current turn's messages = from the last user message to the end of the
 * host's list. Guarantees the live question is included. Falls back to the
 * single last message, or empty when there are none.
 */
function currentTurnTail(hostMessages: AgentMessage[]): AgentMessage[] {
  if (hostMessages.length === 0) return [];
  for (let i = hostMessages.length - 1; i >= 0; i--) {
    if (hostMessages[i]!.role === 'user') return hostMessages.slice(i);
  }
  return [hostMessages[hostMessages.length - 1]!];
}

function agentMessagesTokens(messages: readonly AgentMessage[]): number {
  let total = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') total += estimateTokens(m.content);
  }
  return total;
}

function passThrough(hostMessages: AgentMessage[]): AssembleResult {
  return { messages: hostMessages, estimatedTokens: agentMessagesTokens(hostMessages) };
}
