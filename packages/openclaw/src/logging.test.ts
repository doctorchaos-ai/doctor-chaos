import { describe, it, expect } from 'vitest';
import { createLogger } from './logging.js';

describe('createLogger', () => {
  it('warnOnce de-dupes per key until recovered', () => {
    const lines: string[] = [];
    const log = createLogger((l) => lines.push(l));

    log.warnOnce('k', 'first');
    log.warnOnce('k', 'second'); // suppressed
    expect(lines).toHaveLength(1);

    log.recover('k');
    log.warnOnce('k', 'third'); // re-armed
    expect(lines).toHaveLength(2);
  });

  it('warn always emits', () => {
    const lines: string[] = [];
    const log = createLogger((l) => lines.push(l));
    log.warn('a');
    log.warn('a');
    expect(lines).toHaveLength(2);
  });

  it('formats Error detail with its message', () => {
    const lines: string[] = [];
    const log = createLogger((l) => lines.push(l));
    log.warn('boom', new Error('kaboom'));
    expect(lines[0]).toContain('doctor-chaos');
    expect(lines[0]).toContain('kaboom');
  });
});
