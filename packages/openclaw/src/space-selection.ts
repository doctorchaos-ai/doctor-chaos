/**
 * Topic-space selection for `assemble` (Req 3.1).
 *
 * Picks the space this turn belongs to. Strategy (pure, public-API only — no
 * dependence on core routing internals):
 *  1. Score each space by keyword/name overlap with the incoming prompt.
 *  2. Highest score wins; ties and zero-overlap fall back to most recently
 *     active space (by lastActivityDate).
 *
 * Rationale: by the time `assemble` runs, `ingest` has already routed the
 * current message into its space (bumping lastActivityDate), so "most recently
 * active" is a strong default; the keyword overlap sharpens selection when
 * several spaces are active. LLM-based selection is a fast-follow (task 8).
 */

import type { TopicSpace } from '@doctorchaos-ai/core';

/** Return the id of the most relevant space for `prompt`, or null if none. */
export function chooseSpaceId(
  spaces: readonly TopicSpace[],
  prompt: string | undefined,
): string | null {
  if (spaces.length === 0) return null;

  const byRecency = [...spaces].sort(
    (a, b) => b.lastActivityDate.getTime() - a.lastActivityDate.getTime(),
  );

  const promptText = (prompt ?? '').toLowerCase();
  if (promptText.trim().length === 0) {
    return byRecency[0]!.id;
  }

  let best: { id: string; score: number; recency: number } | null = null;
  for (const space of spaces) {
    const score = overlapScore(space, promptText);
    const recency = space.lastActivityDate.getTime();
    if (
      best === null ||
      score > best.score ||
      (score === best.score && recency > best.recency)
    ) {
      best = { id: space.id, score, recency };
    }
  }

  if (best && best.score > 0) return best.id;
  // No keyword signal — fall back to the most recently active space.
  return byRecency[0]!.id;
}

/** Count of the space's keywords (and name tokens) that appear in the prompt. */
function overlapScore(space: TopicSpace, promptLower: string): number {
  let score = 0;
  for (const kw of space.keywords) {
    const k = kw.toLowerCase().trim();
    if (k.length > 0 && promptLower.includes(k)) score += 1;
  }
  for (const token of space.name.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (token.length >= 2 && promptLower.includes(token)) score += 1;
  }
  return score;
}
