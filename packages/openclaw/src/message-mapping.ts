/**
 * Mapping between OpenClaw `AgentMessage` and Doctor Chaos core message shapes.
 *
 * Doctor Chaos core routes on plain text (`Message.content: string`, role one of
 * 'user' | 'assistant' | 'system'). OpenClaw's `AgentMessage.content` may be a
 * string or a structured/multimodal value, so we extract routable text and
 * degrade safely (never throw) per spec Req 5.
 */

import type { AgentMessage } from './openclaw-types.js';

/** Core-compatible role set. */
export type ClinicRole = 'user' | 'assistant' | 'system';

/** Minimal input accepted by `clinic.send(...)` (structurally). */
export interface ClinicMessageInput {
  role: ClinicRole;
  content: string;
}

/** Coerce an arbitrary OpenClaw role string into a core role. */
export function toClinicRole(role: unknown): ClinicRole {
  if (role === 'assistant' || role === 'system') return role;
  // 'user', 'tool', 'function', and anything unknown route as user content —
  // what matters for topic routing is the text, not the exact speaker.
  return 'user';
}

/**
 * Extract routable text from an OpenClaw message content value.
 * Returns a trimmed string, or null when there is no usable text.
 */
export function extractText(content: unknown): string | null {
  if (typeof content === 'string') {
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (Array.isArray(content)) {
    // OpenAI-style multimodal parts: [{ type:'text', text }, { type:'image_url', ... }]
    const parts: string[] = [];
    for (const part of content) {
      if (typeof part === 'string') {
        if (part.trim()) parts.push(part);
      } else if (part && typeof part === 'object') {
        const text = (part as Record<string, unknown>).text;
        if (typeof text === 'string' && text.trim()) parts.push(text);
      }
      // non-text parts (images, etc.) are skipped — they don't help routing.
    }
    const joined = parts.join('\n').trim();
    return joined.length > 0 ? joined : null;
  }

  if (content && typeof content === 'object') {
    const text = (content as Record<string, unknown>).text;
    if (typeof text === 'string' && text.trim()) return text.trim();
  }

  return null;
}

/**
 * Strip OpenClaw's per-turn wrapper so routing/storage use the actual user
 * utterance, not the injected metadata + replayed conversation history.
 *
 * OpenClaw wraps each message like:
 *   Conversation info (untrusted metadata):
 *   ```json { ... } ```
 *   Sender (untrusted metadata):
 *   ```json { ... } ```
 *   Conversation context (untrusted, chronological, selected for current message):
 *   #83 ... chaos xue: ...
 *   #84 ... OpenClaw: ...
 *
 *   <the actual new message>
 *
 * Routing on the whole blob pollutes keywords (chat_id, timestamps, replayed
 * history) and makes every message look unique. We keep only the trailing
 * utterance after the context block. Falls back to the original text when the
 * wrapper isn't detected or extraction would be empty.
 */
export function stripConversationWrapper(text: string): string {
  const marker = 'Conversation context (untrusted';
  const idx = text.lastIndexOf(marker);
  if (idx === -1) return text;

  const lines = text.slice(idx).split('\n');
  // Find the last replayed context entry line ("#<n> ... : ...").
  let lastEntry = -1;
  for (let i = 1; i < lines.length; i++) {
    if (/^#\d+\b/.test(lines[i]!.trim())) lastEntry = i;
  }
  const tail =
    lastEntry === -1
      ? lines.slice(1).join('\n') // no entries: everything after the header
      : lines.slice(lastEntry + 1).join('\n'); // after the last replayed entry
  const cleaned = tail.trim();
  return cleaned.length > 0 ? cleaned : text;
}

/**
 * Map an OpenClaw `AgentMessage` to a core `clinic.send` input.
 * Returns null when the message carries no routable text (caller should
 * treat that as a no-op ingest).
 */
export function toClinicInput(message: AgentMessage): ClinicMessageInput | null {
  const raw = extractText(message.content);
  if (raw === null) return null;
  const content = stripConversationWrapper(raw);
  if (content.trim().length === 0) return null;
  return { role: toClinicRole(message.role), content };
}

/** Map a core message (role + string content) back to an OpenClaw message. */
export function toAgentMessage(message: {
  role: string;
  content: string;
}): AgentMessage {
  return { role: message.role, content: message.content };
}
