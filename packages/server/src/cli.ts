/**
 * `doctor-chaos-server` CLI entry point.
 *
 * Usage:
 *   doctor-chaos-server start [--port N] [--host H] [--snapshot PATH]
 *                             [--routing-mode auto|llm|embedding|keyword]
 *                             [--llm-base-url URL] [--llm-api-key KEY]
 *                             [--llm-model NAME]   [--llm-format FMT]
 *   doctor-chaos-server --version
 *   doctor-chaos-server --help
 */

import { VERSION } from './version.js';
import { startServer } from './server.js';
import type { LLMConfigOverrides, LLMFormat, RoutingMode } from './routing-mode.js';

const DEFAULT_PORT = 18790;

interface CliArgs {
  readonly command: 'start' | 'help' | 'version';
  readonly port: number;
  readonly host: string;
  readonly snapshotPath: string | undefined;
  readonly routingMode: RoutingMode;
  readonly llmOverrides: LLMConfigOverrides;
}

const VALID_ROUTING_MODES: readonly RoutingMode[] = [
  'auto',
  'llm',
  'embedding',
  'keyword',
];
const VALID_LLM_FORMATS: readonly LLMFormat[] = ['openai-compat', 'anthropic'];

function printHelp(): void {
  // eslint-disable-next-line no-console
  console.log(
    [
      `doctor-chaos-server ${VERSION}`,
      '',
      'Usage:',
      '  doctor-chaos-server start [--port N] [--host H] [--snapshot PATH]',
      '                            [--routing-mode auto|llm|embedding|keyword]',
      '                            [--llm-base-url URL] [--llm-api-key KEY]',
      '                            [--llm-model NAME]   [--llm-format openai-compat|anthropic]',
      '  doctor-chaos-server --version',
      '  doctor-chaos-server --help',
      '',
      'Options:',
      '  --port N            TCP port to listen on (default: 18790, env: DOCTOR_CHAOS_PORT)',
      '  --host H            Hostname to bind (default: 127.0.0.1, loopback only)',
      '  --snapshot PATH     Snapshot file path (default: ~/.doctorchaos/tenants/default/snapshot.json)',
      '  --routing-mode M    Routing tier (default: auto)',
      '                      auto      — LLM if config present, else embedding, else keyword.',
      '                      llm       — force LLM direct routing.',
      '                      embedding — force embedding similarity (needs OPENAI_API_KEY).',
      '                      keyword   — force keyword matcher (zero-dep fallback).',
      '  --llm-base-url URL  LLM endpoint (e.g. https://api.deepseek.com/v1). Overrides env.',
      '  --llm-api-key KEY   LLM API key. Overrides env.',
      '  --llm-model NAME    LLM model name (default: gpt-4o-mini).',
      '  --llm-format F      Wire format: openai-compat (default) or anthropic.',
      '',
      'LLM configuration precedence (highest to lowest):',
      '  1. CLI --llm-* flags',
      '  2. DOCTOR_CHAOS_LLM_BASE_URL / DOCTOR_CHAOS_LLM_API_KEY /',
      '     DOCTOR_CHAOS_LLM_MODEL / DOCTOR_CHAOS_LLM_FORMAT env vars',
      '  3. OPENAI_API_KEY (+ optional OPENAI_BASE_URL, OPENAI_MODEL) as the',
      '     one vendor-specific fallback for zero-config OpenAI users',
      '',
      'Doctor Chaos is provider-agnostic. Any OpenAI-compatible endpoint',
      '(DeepSeek, Kimi, 智谱, 通义, MiniMax, 豆包, OpenRouter, LiteLLM,',
      'Ollama, LM Studio, etc.) or the native Anthropic Messages API works;',
      'point --llm-base-url and --llm-api-key at it.',
      '',
      'This is the Doctor Chaos HTTP daemon. It listens on localhost by',
      'design. For the full list of endpoints see the package README.',
    ].join('\n'),
  );
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args = argv.slice(2);

  const defaults: CliArgs = {
    command: 'help',
    port: DEFAULT_PORT,
    host: '127.0.0.1',
    snapshotPath: undefined,
    routingMode: 'auto',
    llmOverrides: {},
  };

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    return defaults;
  }
  if (args[0] === '--version' || args[0] === '-v') {
    return { ...defaults, command: 'version' };
  }
  if (args[0] !== 'start') {
    throw new Error(
      `Unknown subcommand: '${args[0]}'. Run 'doctor-chaos-server --help' for usage.`,
    );
  }

  let port = DEFAULT_PORT;
  const envPort = process.env['DOCTOR_CHAOS_PORT'];
  if (envPort !== undefined) {
    const parsed = Number.parseInt(envPort, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      port = parsed;
    }
  }
  let host = '127.0.0.1';
  let snapshotPath: string | undefined = undefined;
  let routingMode: RoutingMode = 'auto';
  let llmBaseUrl: string | undefined;
  let llmApiKey: string | undefined;
  let llmModel: string | undefined;
  let llmFormat: LLMFormat | undefined;

  for (let i = 1; i < args.length; i++) {
    const flag = args[i];
    const value = args[i + 1];
    if (flag === '--port') {
      if (value === undefined) throw new Error("'--port' requires a value.");
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`'--port' must be a positive integer; got '${value}'.`);
      }
      port = parsed;
      i++;
    } else if (flag === '--host') {
      if (value === undefined) throw new Error("'--host' requires a value.");
      host = value;
      i++;
    } else if (flag === '--snapshot') {
      if (value === undefined) throw new Error("'--snapshot' requires a value.");
      snapshotPath = value;
      i++;
    } else if (flag === '--routing-mode') {
      if (value === undefined) throw new Error("'--routing-mode' requires a value.");
      if (!VALID_ROUTING_MODES.includes(value as RoutingMode)) {
        throw new Error(
          `'--routing-mode' must be one of ${VALID_ROUTING_MODES.join(', ')}; got '${value}'.`,
        );
      }
      routingMode = value as RoutingMode;
      i++;
    } else if (flag === '--llm-base-url') {
      if (value === undefined) throw new Error("'--llm-base-url' requires a value.");
      llmBaseUrl = value;
      i++;
    } else if (flag === '--llm-api-key') {
      if (value === undefined) throw new Error("'--llm-api-key' requires a value.");
      llmApiKey = value;
      i++;
    } else if (flag === '--llm-model') {
      if (value === undefined) throw new Error("'--llm-model' requires a value.");
      llmModel = value;
      i++;
    } else if (flag === '--llm-format') {
      if (value === undefined) throw new Error("'--llm-format' requires a value.");
      if (!VALID_LLM_FORMATS.includes(value as LLMFormat)) {
        throw new Error(
          `'--llm-format' must be one of ${VALID_LLM_FORMATS.join(', ')}; got '${value}'.`,
        );
      }
      llmFormat = value as LLMFormat;
      i++;
    } else {
      throw new Error(
        `Unknown flag: '${flag}'. Run 'doctor-chaos-server --help' for usage.`,
      );
    }
  }

  const llmOverrides: LLMConfigOverrides = {
    ...(llmBaseUrl !== undefined ? { baseUrl: llmBaseUrl } : {}),
    ...(llmApiKey !== undefined ? { apiKey: llmApiKey } : {}),
    ...(llmModel !== undefined ? { model: llmModel } : {}),
    ...(llmFormat !== undefined ? { format: llmFormat } : {}),
  };

  return {
    command: 'start',
    port,
    host,
    snapshotPath,
    routingMode,
    llmOverrides,
  };
}

async function runStart(args: CliArgs): Promise<void> {
  const server = await startServer({
    port: args.port,
    host: args.host,
    routingMode: args.routingMode,
    llmOverrides: args.llmOverrides,
    ...(args.snapshotPath !== undefined ? { snapshotPath: args.snapshotPath } : {}),
  });

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ event: 'received_signal', signal }));
    try {
      await server.stop();
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
    return;
  }

  if (args.command === 'help') {
    printHelp();
    process.exit(0);
    return;
  }
  if (args.command === 'version') {
    // eslint-disable-next-line no-console
    console.log(VERSION);
    process.exit(0);
    return;
  }

  try {
    await runStart(args);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

void main();
