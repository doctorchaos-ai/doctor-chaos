import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import type {
  Fragment,
  InboxSpace,
  Message,
  RoutingCorrection,
  TopicSpace,
} from '@doctorchaos-ai/core';

/**
 * Shape of `Clinic.snapshot()` — the canonical in-memory form of a
 * tenant's state. Declared here (structurally identical to the core's
 * return type) so the server can consume it without importing the
 * Clinic class itself (avoids a hard runtime dep on core internals
 * beyond the type-only peer).
 */
export interface ClinicSnapshot {
  readonly spaces: readonly TopicSpace[];
  readonly inbox: InboxSpace;
  readonly corrections: readonly RoutingCorrection[];
}

/**
 * Default on-disk path for the single-tenant snapshot.
 *
 * Kept under the user's home directory so the daemon's state follows
 * the user across Node reinstalls and doesn't need elevated permissions
 * to write. The `tenants/default/` nesting is deliberate: when multi-
 * tenancy lights up (see `deferred-requirements.md` D3), the on-disk
 * layout already has the right shape.
 */
export function defaultSnapshotPath(): string {
  return join(homedir(), '.doctorchaos', 'tenants', 'default', 'snapshot.json');
}

/**
 * Serialize a {@link ClinicSnapshot} into a JSON string suitable for
 * disk storage.
 *
 * `JSON.stringify` already converts `Date` to ISO strings — so the
 * wire format is the tidy shape we want. The symmetric `deserialize`
 * does the reverse revive.
 */
export function serializeSnapshot(snapshot: ClinicSnapshot): string {
  return JSON.stringify(snapshot, null, 2);
}

/**
 * Parse a JSON string produced by {@link serializeSnapshot} back into
 * a well-formed {@link ClinicSnapshot}.
 *
 * Every `Date` field in the core types is reconstructed from its ISO
 * string. If the input JSON is malformed, the field set is wrong, or
 * a supposed date fails to parse, this function throws — the daemon's
 * startup path lets that bubble so we fail loudly instead of silently
 * booting with a broken state.
 *
 * This function is the hot spot for Risk R6 from the design doc:
 * every existing `Date` field in core types must be covered here.
 */
export function deserializeSnapshot(json: string): ClinicSnapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new Error(
      `deserializeSnapshot: failed to parse snapshot JSON: ${String(err instanceof Error ? err.message : err)}`,
    );
  }

  if (!isRecord(raw)) {
    throw new Error('deserializeSnapshot: snapshot root is not an object.');
  }

  const { spaces, inbox, corrections } = raw;

  if (!Array.isArray(spaces)) {
    throw new Error('deserializeSnapshot: `spaces` must be an array.');
  }
  if (!isRecord(inbox)) {
    throw new Error('deserializeSnapshot: `inbox` must be an object.');
  }
  if (!Array.isArray(corrections)) {
    throw new Error('deserializeSnapshot: `corrections` must be an array.');
  }

  return {
    spaces: spaces.map(reviveTopicSpace),
    inbox: reviveInbox(inbox),
    corrections: corrections.map(reviveCorrection),
  };
}

/**
 * Atomically write a snapshot to disk.
 *
 * Strategy: write to `<path>.tmp`, `rename` over `<path>`. On POSIX
 * `rename` is atomic within the same filesystem — the only two
 * observable states for readers are "the old file" and "the new
 * file", never a half-written hybrid.
 *
 * Failures (disk full, permissions, etc.) clean up the `.tmp` file
 * where possible and re-throw.
 */
export async function writeSnapshot(path: string, snapshot: ClinicSnapshot): Promise<void> {
  const parent = parentDir(path);
  const tmpPath = `${path}.tmp`;
  await mkdir(parent, { recursive: true });
  try {
    await writeFile(tmpPath, serializeSnapshot(snapshot), { encoding: 'utf8' });
    await rename(tmpPath, path);
  } catch (err) {
    // Best-effort cleanup of the temp file. Ignore "ENOENT" (nothing
    // to clean) and swallow other errors so the original failure is
    // what the caller sees.
    await unlink(tmpPath).catch(() => undefined);
    throw err;
  }
}

/**
 * Load a snapshot from disk.
 *
 * Returns `null` if the file does not exist (first-run case). Throws
 * if the file exists but is unreadable or malformed — the daemon
 * must not silently start with a broken or missing state when one
 * was expected.
 */
export async function loadSnapshot(path: string): Promise<ClinicSnapshot | null> {
  let contents: string;
  try {
    contents = await readFile(path, { encoding: 'utf8' });
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      return null;
    }
    throw err;
  }
  return deserializeSnapshot(contents);
}

// ─── Revive helpers ──────────────────────────────────────────────────

function reviveTopicSpace(raw: unknown): TopicSpace {
  if (!isRecord(raw)) {
    throw new Error('deserializeSnapshot: topic space entry is not an object.');
  }
  const messages = raw['messages'];
  if (!Array.isArray(messages)) {
    throw new Error('deserializeSnapshot: topic space is missing `messages` array.');
  }
  return {
    id: mustString(raw, 'id'),
    name: mustString(raw, 'name'),
    keywords: requireStringArray(raw, 'keywords'),
    createdDate: reviveDate(raw['createdDate'], 'topicSpace.createdDate'),
    lastActivityDate: reviveDate(raw['lastActivityDate'], 'topicSpace.lastActivityDate'),
    creationSource: mustString(raw, 'creationSource') as TopicSpace['creationSource'],
    status: mustString(raw, 'status') as TopicSpace['status'],
    ...(typeof raw['contextSummary'] === 'string'
      ? { contextSummary: raw['contextSummary'] }
      : {}),
    messages: messages.map(reviveMessage),
  };
}

function reviveInbox(raw: Record<string, unknown>): InboxSpace {
  const fragments = raw['fragments'];
  if (!Array.isArray(fragments)) {
    throw new Error('deserializeSnapshot: inbox is missing `fragments` array.');
  }
  const totalMessageCount = raw['totalMessageCount'];
  if (typeof totalMessageCount !== 'number') {
    throw new Error('deserializeSnapshot: inbox.totalMessageCount must be a number.');
  }
  return {
    id: mustString(raw, 'id'),
    fragments: fragments.map(reviveFragment),
    totalMessageCount,
  };
}

function reviveFragment(raw: unknown): Fragment {
  if (!isRecord(raw)) {
    throw new Error('deserializeSnapshot: fragment entry is not an object.');
  }
  const messages = raw['messages'];
  if (!Array.isArray(messages)) {
    throw new Error('deserializeSnapshot: fragment is missing `messages` array.');
  }
  return {
    id: mustString(raw, 'id'),
    messages: messages.map(reviveMessage),
    timestamp: reviveDate(raw['timestamp'], 'fragment.timestamp'),
    keywords: requireStringArray(raw, 'keywords'),
    ...(typeof raw['clusterHint'] === 'string' ? { clusterHint: raw['clusterHint'] } : {}),
  };
}

function reviveMessage(raw: unknown): Message {
  if (!isRecord(raw)) {
    throw new Error('deserializeSnapshot: message entry is not an object.');
  }
  const base: Message = {
    id: mustString(raw, 'id'),
    role: mustString(raw, 'role') as Message['role'],
    content: mustString(raw, 'content'),
    timestamp: reviveDate(raw['timestamp'], 'message.timestamp'),
  };
  const routing = raw['routing'];
  if (isRecord(routing)) {
    return {
      ...base,
      routing: {
        originalDestination: mustString(routing, 'originalDestination'),
        confidence:
          typeof routing['confidence'] === 'number'
            ? routing['confidence']
            : Number.NaN,
        wasReassigned: Boolean(routing['wasReassigned']),
        ...(typeof routing['reassignedFrom'] === 'string'
          ? { reassignedFrom: routing['reassignedFrom'] }
          : {}),
      },
    };
  }
  return base;
}

function reviveCorrection(raw: unknown): RoutingCorrection {
  if (!isRecord(raw)) {
    throw new Error('deserializeSnapshot: correction entry is not an object.');
  }
  return {
    id: mustString(raw, 'id'),
    messageId: mustString(raw, 'messageId'),
    originalDestination: mustString(raw, 'originalDestination'),
    correctedDestination: mustString(raw, 'correctedDestination'),
    timestamp: reviveDate(raw['timestamp'], 'correction.timestamp'),
    messageContent: mustString(raw, 'messageContent'),
  };
}

// ─── Tiny typed helpers ─────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mustString(raw: Record<string, unknown>, key: string): string {
  const v = raw[key];
  if (typeof v !== 'string') {
    throw new Error(`deserializeSnapshot: field '${key}' must be a string.`);
  }
  return v;
}

function requireStringArray(raw: Record<string, unknown>, key: string): readonly string[] {
  const v = raw[key];
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
    throw new Error(`deserializeSnapshot: field '${key}' must be an array of strings.`);
  }
  return v;
}

function reviveDate(value: unknown, context: string): Date {
  if (typeof value !== 'string') {
    throw new Error(`deserializeSnapshot: ${context} must be an ISO date string.`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`deserializeSnapshot: ${context} is not a valid ISO date: '${value}'.`);
  }
  return parsed;
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && typeof (err as NodeJS.ErrnoException).code === 'string';
}

function parentDir(path: string): string {
  const i = path.lastIndexOf('/');
  if (i === -1) return '.';
  return path.slice(0, i);
}
