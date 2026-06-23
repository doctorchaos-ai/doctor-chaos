/**
 * Per-session persistence for the Doctor Chaos OpenClaw plugin.
 *
 * Stores enough of `Clinic.snapshot()` to rehydrate topic spaces + inbox
 * across OpenClaw restarts (Req 8). Keyed by sessionId so each OpenClaw
 * conversation gets its own topic map.
 *
 * Fail-soft by design (unlike @doctorchaos-ai/server, which fails loudly):
 * a missing or malformed snapshot yields `null` so the engine starts with an
 * empty Clinic instead of crashing OpenClaw (Req 8.3). Dates are revived from
 * their ISO strings for the fields the Clinic constructor consumes
 * (`initialSpaces` / `initialInbox`).
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import type { InboxSpace, TopicSpace } from '@doctorchaos-ai/core';

/** The subset of clinic state we persist and rehydrate. */
export interface PersistedState {
  spaces: TopicSpace[];
  inbox: InboxSpace;
}

/** Root dir for plugin snapshots (distinct from the daemon's tenants/ tree). */
export function sessionSnapshotPath(sessionId: string): string {
  const safe = sanitizeSessionId(sessionId);
  return join(homedir(), '.doctorchaos', 'openclaw', safe, 'snapshot.json');
}

function sanitizeSessionId(sessionId: string): string {
  const cleaned = sessionId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200);
  return cleaned.length > 0 ? cleaned : 'default';
}

/** Atomically write state to disk (tmp + rename). Throws only on I/O failure. */
export async function saveState(path: string, state: PersistedState): Promise<void> {
  const parent = parentDir(path);
  const tmpPath = `${path}.tmp`;
  await mkdir(parent, { recursive: true });
  try {
    await writeFile(tmpPath, JSON.stringify({ spaces: state.spaces, inbox: state.inbox }, null, 2), {
      encoding: 'utf8',
    });
    await rename(tmpPath, path);
  } catch (err) {
    await unlink(tmpPath).catch(() => undefined);
    throw err;
  }
}

/**
 * Load and revive persisted state. Returns `null` when the file is absent
 * (first run). Throws on malformed content so the caller can warn and start
 * with an empty Clinic (Req 8.3).
 */
export async function loadState(path: string): Promise<PersistedState | null> {
  let contents: string;
  try {
    contents = await readFile(path, { encoding: 'utf8' });
  } catch {
    return null; // missing file -> first run / empty
  }
  return reviveState(contents); // malformed -> throws, handled by caller
}

/** Parse + revive Dates. Throws on malformed input (caught by loadState). */
export function reviveState(json: string): PersistedState {
  const raw: unknown = JSON.parse(json);
  if (!isRecord(raw)) throw new Error('snapshot root is not an object');
  const { spaces, inbox } = raw;
  if (!Array.isArray(spaces)) throw new Error('`spaces` must be an array');
  if (!isRecord(inbox)) throw new Error('`inbox` must be an object');
  return {
    spaces: spaces.map(reviveSpace),
    inbox: reviveInbox(inbox),
  };
}

// ─── revive helpers ──────────────────────────────────────────────────

function reviveSpace(raw: unknown): TopicSpace {
  if (!isRecord(raw)) throw new Error('topic space entry is not an object');
  const messages = raw['messages'];
  if (!Array.isArray(messages)) throw new Error('topic space missing messages[]');
  return {
    ...(raw as Record<string, unknown>),
    createdDate: reviveDate(raw['createdDate']),
    lastActivityDate: reviveDate(raw['lastActivityDate']),
    messages: messages.map(reviveMessage),
  } as unknown as TopicSpace;
}

function reviveInbox(raw: Record<string, unknown>): InboxSpace {
  const fragments = raw['fragments'];
  if (!Array.isArray(fragments)) throw new Error('inbox missing fragments[]');
  return {
    ...(raw as Record<string, unknown>),
    fragments: fragments.map(reviveFragment),
  } as unknown as InboxSpace;
}

function reviveFragment(raw: unknown): unknown {
  if (!isRecord(raw)) throw new Error('fragment entry is not an object');
  const messages = raw['messages'];
  if (!Array.isArray(messages)) throw new Error('fragment missing messages[]');
  return {
    ...(raw as Record<string, unknown>),
    timestamp: reviveDate(raw['timestamp']),
    messages: messages.map(reviveMessage),
  };
}

function reviveMessage(raw: unknown): unknown {
  if (!isRecord(raw)) throw new Error('message entry is not an object');
  return {
    ...(raw as Record<string, unknown>),
    timestamp: reviveDate(raw['timestamp']),
  };
}

function reviveDate(value: unknown): Date {
  if (typeof value !== 'string') throw new Error('expected ISO date string');
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid ISO date: ${value}`);
  return d;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parentDir(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '.' : path.slice(0, i);
}
