/**
 * Routing-strategy resolution for the daemon.
 *
 * Doctor Chaos is provider-agnostic by design. The LLM tier is
 * driven by a small set of Doctor-Chaos-owned config values:
 *
 *   - DOCTOR_CHAOS_LLM_BASE_URL   (required for LLM tier)
 *   - DOCTOR_CHAOS_LLM_API_KEY    (required for LLM tier)
 *   - DOCTOR_CHAOS_LLM_MODEL      (required for LLM tier)
 *   - DOCTOR_CHAOS_LLM_FORMAT     (optional; 'openai-compat' | 'anthropic';
 *                                   default 'openai-compat')
 *
 * That is enough to speak to OpenAI, DeepSeek, Kimi, 智谱, 通义,
 * MiniMax, 豆包, Anthropic, OpenRouter, LiteLLM, OneAPI, Ollama,
 * LM Studio, and anything else that speaks either protocol. No
 * per-vendor enumeration.
 *
 * For backward compatibility and zero-config OpenAI users, we still
 * fall back to the existing OPENAI_API_KEY + OPENAI_BASE_URL pair
 * when the Doctor-Chaos-owned vars are not set. That single case is
 * the exception because it is the only public API format that
 * predates this config and is the de-facto Internet standard.
 *
 * Precedence at ``auto`` mode:
 *   1. LLM tier if DOCTOR_CHAOS_LLM_* (or OPENAI_API_KEY fallback)
 *   2. Embedding tier if OPENAI_API_KEY present (Clinic built-in)
 *   3. Keyword tier (zero-dependency fallback)
 *
 * The CLI can force a tier with ``--routing-mode`` and override
 * each config field individually with ``--llm-base-url``,
 * ``--llm-api-key``, ``--llm-model``, ``--llm-format``.
 */

import type { ClinicOptions, LLMFunction } from '@doctorchaos-ai/core';

export type RoutingMode = 'auto' | 'llm' | 'embedding' | 'keyword';

export type LLMFormat = 'openai-compat' | 'anthropic';

/**
 * CLI-supplied LLM configuration overrides. Anything absent here
 * falls through to env; anything absent from env falls through to
 * the OpenAI compatibility defaults where possible.
 */
export interface LLMConfigOverrides {
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly model?: string;
  readonly format?: LLMFormat;
}

/**
 * Fully-resolved LLM config, ready to build a fetch call from.
 *
 * @internal
 */
interface ResolvedLLMConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly format: LLMFormat;
  /** Which layer the config ended up coming from, for startup log. */
  readonly source: 'explicit' | 'openai-fallback';
}

/**
 * Read the first defined non-empty value among ``names``.
 */
function readEnv(
  env: Record<string, string | undefined>,
  ...names: readonly string[]
): string | undefined {
  for (const n of names) {
    const v = env[n];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

/**
 * Resolve the four LLM config fields from (in order):
 *   1. CLI overrides
 *   2. DOCTOR_CHAOS_LLM_* env vars
 *   3. The single OPENAI_API_KEY-based fallback
 *
 * Returns ``undefined`` when none of those supply both a base URL
 * and an API key — without those two the LLM tier cannot function.
 */
function resolveLLMConfig(
  env: Record<string, string | undefined>,
  overrides: LLMConfigOverrides,
): ResolvedLLMConfig | undefined {
  // Layer 1 + 2: explicit config (CLI wins over env).
  const explicitBaseUrl =
    overrides.baseUrl ?? readEnv(env, 'DOCTOR_CHAOS_LLM_BASE_URL');
  const explicitApiKey =
    overrides.apiKey ?? readEnv(env, 'DOCTOR_CHAOS_LLM_API_KEY');
  const explicitModel = overrides.model ?? readEnv(env, 'DOCTOR_CHAOS_LLM_MODEL');
  const explicitFormatRaw =
    overrides.format ?? readEnv(env, 'DOCTOR_CHAOS_LLM_FORMAT');

  if (explicitBaseUrl && explicitApiKey) {
    const format = normaliseFormat(explicitFormatRaw);
    return {
      baseUrl: stripTrailingSlash(explicitBaseUrl),
      apiKey: explicitApiKey,
      model: explicitModel ?? 'gpt-4o-mini',
      format,
      source: 'explicit',
    };
  }

  // Layer 3: OpenAI-only fallback (the one exception — OpenAI's
  // env-var convention is the de-facto Internet standard, predates
  // this config, and most users already have it set).
  const openaiKey = readEnv(env, 'OPENAI_API_KEY');
  if (openaiKey) {
    return {
      baseUrl: stripTrailingSlash(
        readEnv(env, 'OPENAI_BASE_URL') ?? 'https://api.openai.com/v1',
      ),
      apiKey: openaiKey,
      model: readEnv(env, 'OPENAI_MODEL') ?? 'gpt-4o-mini',
      format: 'openai-compat',
      source: 'openai-fallback',
    };
  }

  return undefined;
}

function normaliseFormat(raw: string | undefined): LLMFormat {
  if (raw === 'anthropic') return 'anthropic';
  return 'openai-compat';
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/$/, '');
}

// ─── LLMFunction builders ────────────────────────────────────────────

function buildOpenAICompatLLM(cfg: ResolvedLLMConfig): LLMFunction {
  return async (prompt: string) => {
    const response = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
      }),
    });
    if (!response.ok) {
      throw new Error(
        `Doctor Chaos: LLM chat-completion call failed (${response.status}).`,
      );
    }
    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new Error('Doctor Chaos: LLM response missing message.content.');
    }
    return content;
  };
}

function buildAnthropicLLM(cfg: ResolvedLLMConfig): LLMFunction {
  return async (prompt: string) => {
    const response = await fetch(`${cfg.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!response.ok) {
      throw new Error(
        `Doctor Chaos: anthropic messages call failed (${response.status}).`,
      );
    }
    const body = (await response.json()) as {
      content?: Array<{ type?: string; text?: string }>;
    };
    const textBlock = body.content?.find((c) => c.type === 'text');
    if (!textBlock || typeof textBlock.text !== 'string') {
      throw new Error('Doctor Chaos: anthropic response missing content[].text.');
    }
    return textBlock.text;
  };
}

function buildLLM(cfg: ResolvedLLMConfig): LLMFunction {
  return cfg.format === 'anthropic' ? buildAnthropicLLM(cfg) : buildOpenAICompatLLM(cfg);
}

// ─── Public API ──────────────────────────────────────────────────────

export interface RoutingResolution {
  readonly options: Partial<ClinicOptions>;
  readonly picked: 'llm' | 'embedding' | 'keyword';
  /** Non-undefined when picked === 'llm'. */
  readonly llmConfig?: {
    readonly baseUrl: string;
    readonly model: string;
    readonly format: LLMFormat;
    readonly source: ResolvedLLMConfig['source'];
  };
}

/**
 * Decide what routing options to hand Clinic, for the requested mode
 * and the current environment + CLI overrides.
 */
export function resolveRoutingOptions(
  requested: RoutingMode,
  env: Record<string, string | undefined> = process.env,
  overrides: LLMConfigOverrides = {},
): RoutingResolution {
  switch (requested) {
    case 'keyword':
      return { options: { autoDetectOpenAI: false }, picked: 'keyword' };

    case 'embedding': {
      if (readEnv(env, 'OPENAI_API_KEY')) {
        return { options: { autoDetectOpenAI: true }, picked: 'embedding' };
      }
      return { options: { autoDetectOpenAI: false }, picked: 'keyword' };
    }

    case 'llm': {
      const cfg = resolveLLMConfig(env, overrides);
      if (cfg) {
        return {
          options: { llm: buildLLM(cfg), autoDetectOpenAI: false },
          picked: 'llm',
          llmConfig: {
            baseUrl: cfg.baseUrl,
            model: cfg.model,
            format: cfg.format,
            source: cfg.source,
          },
        };
      }
      return { options: { autoDetectOpenAI: false }, picked: 'keyword' };
    }

    case 'auto':
    default: {
      // 1. Any fully-specified LLM config wins.
      const cfg = resolveLLMConfig(env, overrides);
      if (cfg) {
        return {
          options: { llm: buildLLM(cfg), autoDetectOpenAI: false },
          picked: 'llm',
          llmConfig: {
            baseUrl: cfg.baseUrl,
            model: cfg.model,
            format: cfg.format,
            source: cfg.source,
          },
        };
      }
      // 2. Embedding tier needs OPENAI_API_KEY specifically; but
      //    that path is actually caught by step 1's fallback today.
      //    Leaving the branch as a no-op safety net.
      if (readEnv(env, 'OPENAI_API_KEY')) {
        return { options: { autoDetectOpenAI: true }, picked: 'embedding' };
      }
      // 3. Keyword.
      return { options: { autoDetectOpenAI: false }, picked: 'keyword' };
    }
  }
}
