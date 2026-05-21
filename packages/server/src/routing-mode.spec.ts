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
  it('auto: activates LLM tier when base_url + api_key are both set', () => {
    const r = resolveRoutingOptions('auto', {
      DOCTOR_CHAOS_LLM_BASE_URL: 'https://api.deepseek.com/v1',
      DOCTOR_CHAOS_LLM_API_KEY: 'sk-x',
      DOCTOR_CHAOS_LLM_MODEL: 'deepseek-chat',
    });
    expect(r.picked).toBe('llm');
    expect(r.llmConfig?.baseUrl).toBe('https://api.deepseek.com/v1');
    expect(r.llmConfig?.model).toBe('deepseek-chat');
    expect(r.llmConfig?.format).toBe('openai-compat');
    expect(r.llmConfig?.source).toBe('explicit');
    expect(r.options.llm).toBeTypeOf('function');
  });

  it('strips trailing slashes from base_url', () => {
    const r = resolveRoutingOptions('auto', {
      DOCTOR_CHAOS_LLM_BASE_URL: 'https://api.example.com/v1/',
      DOCTOR_CHAOS_LLM_API_KEY: 'sk-x',
    });
    expect(r.llmConfig?.baseUrl).toBe('https://api.example.com/v1');
  });

  it('honours DOCTOR_CHAOS_LLM_FORMAT=anthropic', () => {
    const r = resolveRoutingOptions('auto', {
      DOCTOR_CHAOS_LLM_BASE_URL: 'https://api.anthropic.com/v1',
      DOCTOR_CHAOS_LLM_API_KEY: 'sk-ant',
      DOCTOR_CHAOS_LLM_MODEL: 'claude-3-5-haiku-20241022',
      DOCTOR_CHAOS_LLM_FORMAT: 'anthropic',
    });
    expect(r.picked).toBe('llm');
    expect(r.llmConfig?.format).toBe('anthropic');
  });

  it('unknown DOCTOR_CHAOS_LLM_FORMAT values silently become openai-compat', () => {
    const r = resolveRoutingOptions('auto', {
      DOCTOR_CHAOS_LLM_BASE_URL: 'https://x/v1',
      DOCTOR_CHAOS_LLM_API_KEY: 'sk-x',
      DOCTOR_CHAOS_LLM_FORMAT: 'not-real',
    });
    expect(r.llmConfig?.format).toBe('openai-compat');
  });

  it('missing base_url or api_key forces fallback path', () => {
    const onlyUrl = resolveRoutingOptions('auto', {
      DOCTOR_CHAOS_LLM_BASE_URL: 'https://x/v1',
    });
    expect(onlyUrl.picked).toBe('keyword');
    const onlyKey = resolveRoutingOptions('auto', {
      DOCTOR_CHAOS_LLM_API_KEY: 'sk-x',
    });
    expect(onlyKey.picked).toBe('keyword');
  });

  it('default model is gpt-4o-mini when DOCTOR_CHAOS_LLM_MODEL is unset', () => {
    const r = resolveRoutingOptions('auto', {
      DOCTOR_CHAOS_LLM_BASE_URL: 'https://x/v1',
      DOCTOR_CHAOS_LLM_API_KEY: 'sk-x',
    });
    expect(r.llmConfig?.model).toBe('gpt-4o-mini');
  });
});

describe('resolveRoutingOptions — CLI overrides beat env', () => {
  it('applies CLI baseUrl/apiKey/model/format over env', () => {
    const r = resolveRoutingOptions(
      'auto',
      {
        DOCTOR_CHAOS_LLM_BASE_URL: 'https://env-url/v1',
        DOCTOR_CHAOS_LLM_API_KEY: 'env-key',
        DOCTOR_CHAOS_LLM_MODEL: 'env-model',
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

  it('CLI alone (no env) also activates the LLM tier', () => {
    const r = resolveRoutingOptions(
      'auto',
      {},
      { baseUrl: 'https://cli/v1', apiKey: 'k' },
    );
    expect(r.picked).toBe('llm');
    expect(r.llmConfig?.source).toBe('explicit');
  });
});

describe('resolveRoutingOptions — OpenAI-only fallback', () => {
  it('auto: OPENAI_API_KEY alone activates LLM via the compat fallback', () => {
    const r = resolveRoutingOptions('auto', { OPENAI_API_KEY: 'sk-x' });
    expect(r.picked).toBe('llm');
    expect(r.llmConfig?.source).toBe('openai-fallback');
    expect(r.llmConfig?.baseUrl).toBe('https://api.openai.com/v1');
    expect(r.llmConfig?.model).toBe('gpt-4o-mini');
    expect(r.llmConfig?.format).toBe('openai-compat');
  });

  it('OPENAI_BASE_URL and OPENAI_MODEL override fallback defaults', () => {
    const r = resolveRoutingOptions('auto', {
      OPENAI_API_KEY: 'sk-x',
      OPENAI_BASE_URL: 'https://proxy/v1',
      OPENAI_MODEL: 'some-proxy-model',
    });
    expect(r.llmConfig?.baseUrl).toBe('https://proxy/v1');
    expect(r.llmConfig?.model).toBe('some-proxy-model');
  });

  it('DOCTOR_CHAOS_LLM_* wins when both it and OPENAI_API_KEY are set', () => {
    const r = resolveRoutingOptions('auto', {
      DOCTOR_CHAOS_LLM_BASE_URL: 'https://explicit/v1',
      DOCTOR_CHAOS_LLM_API_KEY: 'explicit-key',
      OPENAI_API_KEY: 'openai-key',
    });
    expect(r.llmConfig?.source).toBe('explicit');
    expect(r.llmConfig?.baseUrl).toBe('https://explicit/v1');
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
