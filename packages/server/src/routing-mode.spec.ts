import { describe, expect, it } from 'vitest';
import { resolveRoutingOptions } from './routing-mode.js';

/**
 * Unit tests for the routing-mode resolver.
 *
 * Design goals exercised here:
 *   - The explicit DOCTOR_CHAOS_LLM_* vars always take precedence.
 *   - OPENAI_API_KEY alone still works (the one backward-compat
 *     fallback — and the only vendor-specific knowledge left in the
 *     daemon).
 *   - CLI overrides win over env.
 *   - No other vendor key (ANTHROPIC_API_KEY, DEEPSEEK_API_KEY, ...)
 *     activates the LLM tier on its own — that enumeration problem
 *     is explicitly out of the design.
 */

describe('resolveRoutingOptions — explicit DOCTOR_CHAOS_LLM_*', () => {
  it('auto: always picks keyword tier regardless of env vars', () => {
    const r = resolveRoutingOptions('auto', {
      DOCTOR_CHAOS_LLM_BASE_URL: 'https://api.deepseek.com/v1',
      DOCTOR_CHAOS_LLM_API_KEY: 'sk-x',
      DOCTOR_CHAOS_LLM_MODEL: 'deepseek-chat',
    });
    expect(r.picked).toBe('keyword');
    expect(r.options.llm).toBeUndefined();
    expect(r.options.autoDetectOpenAI).toBe(false);
  });

  it('auto: ignores OPENAI_API_KEY too', () => {
    const r = resolveRoutingOptions('auto', { OPENAI_API_KEY: 'sk-x' });
    expect(r.picked).toBe('keyword');
    expect(r.options.autoDetectOpenAI).toBe(false);
  });
});

describe('resolveRoutingOptions — explicit llm mode still works', () => {
  it('llm mode: activates when base_url + api_key are set', () => {
    const r = resolveRoutingOptions('llm', {
      DOCTOR_CHAOS_LLM_BASE_URL: 'https://api.deepseek.com/v1',
      DOCTOR_CHAOS_LLM_API_KEY: 'sk-x',
      DOCTOR_CHAOS_LLM_MODEL: 'deepseek-chat',
    });
    expect(r.picked).toBe('llm');
    expect(r.llmConfig?.baseUrl).toBe('https://api.deepseek.com/v1');
    expect(r.llmConfig?.model).toBe('deepseek-chat');
    expect(r.options.llm).toBeTypeOf('function');
  });

  it('llm mode: strips trailing slashes from base_url', () => {
    const r = resolveRoutingOptions('llm', {
      DOCTOR_CHAOS_LLM_BASE_URL: 'https://api.example.com/v1/',
      DOCTOR_CHAOS_LLM_API_KEY: 'sk-x',
    });
    expect(r.llmConfig?.baseUrl).toBe('https://api.example.com/v1');
  });

  it('llm mode: honours DOCTOR_CHAOS_LLM_FORMAT=anthropic', () => {
    const r = resolveRoutingOptions('llm', {
      DOCTOR_CHAOS_LLM_BASE_URL: 'https://api.anthropic.com/v1',
      DOCTOR_CHAOS_LLM_API_KEY: 'sk-ant',
      DOCTOR_CHAOS_LLM_MODEL: 'claude-3-5-haiku-20241022',
      DOCTOR_CHAOS_LLM_FORMAT: 'anthropic',
    });
    expect(r.picked).toBe('llm');
    expect(r.llmConfig?.format).toBe('anthropic');
  });

  it('llm mode: falls back to keyword when no config', () => {
    const r = resolveRoutingOptions('llm', {});
    expect(r.picked).toBe('keyword');
  });

  it('llm mode: OPENAI_API_KEY fallback still works', () => {
    const r = resolveRoutingOptions('llm', { OPENAI_API_KEY: 'sk-x' });
    expect(r.picked).toBe('llm');
    expect(r.llmConfig?.source).toBe('openai-fallback');
  });

  it('llm mode: CLI overrides beat env', () => {
    const r = resolveRoutingOptions(
      'llm',
      {
        DOCTOR_CHAOS_LLM_BASE_URL: 'https://env-url/v1',
        DOCTOR_CHAOS_LLM_API_KEY: 'env-key',
      },
      {
        baseUrl: 'https://cli-url/v1',
        apiKey: 'cli-key',
        model: 'cli-model',
        format: 'anthropic',
      },
    );
    expect(r.llmConfig?.baseUrl).toBe('https://cli-url/v1');
    expect(r.llmConfig?.model).toBe('cli-model');
    expect(r.llmConfig?.format).toBe('anthropic');
  });
});

describe('resolveRoutingOptions — OpenAI-only fallback removed', () => {
  it('auto: OPENAI_API_KEY alone does NOT activate LLM anymore', () => {
    const r = resolveRoutingOptions('auto', { OPENAI_API_KEY: 'sk-x' });
    expect(r.picked).toBe('keyword');
    expect(r.llmConfig).toBeUndefined();
    expect(r.options.autoDetectOpenAI).toBe(false);
  });

  it('auto: OPENAI_BASE_URL and OPENAI_MODEL are ignored in auto mode', () => {
    const r = resolveRoutingOptions('auto', {
      OPENAI_API_KEY: 'sk-x',
      OPENAI_BASE_URL: 'https://proxy/v1',
      OPENAI_MODEL: 'some-proxy-model',
    });
    expect(r.picked).toBe('keyword');
  });

  it('DOCTOR_CHAOS_LLM_* is ignored in auto mode too', () => {
    const r = resolveRoutingOptions('auto', {
      DOCTOR_CHAOS_LLM_BASE_URL: 'https://explicit/v1',
      DOCTOR_CHAOS_LLM_API_KEY: 'explicit-key',
      OPENAI_API_KEY: 'openai-key',
    });
    expect(r.picked).toBe('keyword');
  });
});

describe('resolveRoutingOptions — forced modes', () => {
  it('keyword: forces keyword regardless of env', () => {
    const r = resolveRoutingOptions('keyword', {
      DOCTOR_CHAOS_LLM_BASE_URL: 'https://x/v1',
      DOCTOR_CHAOS_LLM_API_KEY: 'k',
    });
    expect(r.picked).toBe('keyword');
  });

  it('llm: forces LLM when config is present', () => {
    const r = resolveRoutingOptions('llm', { OPENAI_API_KEY: 'sk-x' });
    expect(r.picked).toBe('llm');
  });

  it('llm: falls back to keyword when no config (caller warns)', () => {
    const r = resolveRoutingOptions('llm', {});
    expect(r.picked).toBe('keyword');
  });

  it('embedding: needs OPENAI_API_KEY (core dependency)', () => {
    const r = resolveRoutingOptions('embedding', { OPENAI_API_KEY: 'sk-x' });
    expect(r.picked).toBe('embedding');
    expect(r.options.autoDetectOpenAI).toBe(true);
  });

  it('embedding: does NOT activate for DOCTOR_CHAOS_LLM_* alone', () => {
    // Embedding tier is backed by Clinic's built-in sniff which
    // needs OPENAI_API_KEY specifically. DOCTOR_CHAOS_LLM_* alone
    // cannot activate embeddings.
    const r = resolveRoutingOptions('embedding', {
      DOCTOR_CHAOS_LLM_BASE_URL: 'https://x/v1',
      DOCTOR_CHAOS_LLM_API_KEY: 'k',
    });
    expect(r.picked).toBe('keyword');
  });
});

describe('resolveRoutingOptions — non-activation of vendor keys', () => {
  // These tests lock in the "no vendor enumeration" decision. Each
  // of these vendor-specific env vars used to activate the LLM tier
  // in an earlier iteration; they must not anymore.
  it.each([
    'ANTHROPIC_API_KEY',
    'DEEPSEEK_API_KEY',
    'MOONSHOT_API_KEY',
    'KIMI_API_KEY',
    'ZHIPUAI_API_KEY',
    'DASHSCOPE_API_KEY',
    'MINIMAX_API_KEY',
    'ARK_API_KEY',
    'DOUBAO_API_KEY',
  ])('auto: %s alone does NOT activate the LLM tier', (keyName) => {
    const r = resolveRoutingOptions('auto', { [keyName]: 'sk-test' });
    expect(r.picked).toBe('keyword');
  });
});
