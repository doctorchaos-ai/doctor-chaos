/**
 * Minimal structured logging with per-key de-duplication for degradation
 * states (Req 7.2): a given degradation is warned once and not repeated until
 * it recovers.
 */

export interface PluginLogger {
  /** Warn once per `key` until `recover(key)` is called. */
  warnOnce(key: string, message: string, detail?: unknown): void;
  /** Clear a degradation key so a future occurrence warns again. */
  recover(key: string): void;
  /** Always-warn (no dedup). */
  warn(message: string, detail?: unknown): void;
}

export function createLogger(sink: (line: string) => void = (l) => console.warn(l)): PluginLogger {
  const warned = new Set<string>();
  const fmt = (message: string, detail?: unknown): string => {
    const base = `[doctor-chaos] ${message}`;
    if (detail === undefined) return base;
    const text = detail instanceof Error ? detail.message : safeStringify(detail);
    return `${base} — ${text}`;
  };
  return {
    warnOnce(key, message, detail) {
      if (warned.has(key)) return;
      warned.add(key);
      sink(fmt(message, detail));
    },
    recover(key) {
      warned.delete(key);
    },
    warn(message, detail) {
      sink(fmt(message, detail));
    },
  };
}

function safeStringify(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}
