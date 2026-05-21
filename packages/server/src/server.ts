import { serve, type ServerType } from '@hono/node-server';
import { Clinic } from '@doctorchaos-ai/core';
import { createHttpApp, type PersistFn } from './http.js';
import {
  defaultSnapshotPath,
  loadSnapshot,
  writeSnapshot,
  type ClinicSnapshot,
} from './persistence.js';
import {
  resolveRoutingOptions,
  type LLMConfigOverrides,
  type RoutingMode,
} from './routing-mode.js';

/**
 * Options for {@link startServer}. Full runtime knobs; the CLI parses
 * argv into this shape.
 */
export interface StartServerOptions {
  readonly port: number;
  readonly host?: string;
  readonly snapshotPath?: string;
  /**
   * Which routing tier to use:
   *   - ``'auto'`` (default): LLM if DOCTOR_CHAOS_LLM_* or
   *     OPENAI_API_KEY are set, embedding if only an OpenAI key is
   *     present (caught by the LLM path in practice), keyword
   *     otherwise.
   *   - ``'llm'``: force LLM; falls back to keyword if no config.
   *   - ``'embedding'``: force embedding; needs OPENAI_API_KEY.
   *   - ``'keyword'``: always the zero-dep keyword matcher.
   */
  readonly routingMode?: RoutingMode;
  /**
   * Explicit LLM config overrides from the CLI, merged over env.
   * Any field left undefined falls through to env then fallback.
   */
  readonly llmOverrides?: LLMConfigOverrides;
  /**
   * Grace period in ms to wait for in-flight requests to complete on
   * graceful shutdown before hard-exiting. Default 5000.
   */
  readonly shutdownGraceMs?: number;
}

/**
 * A handle to a running daemon. The CLI holds one of these and
 * invokes `stop()` when it catches SIGINT / SIGTERM.
 */
export interface RunningServer {
  readonly address: { host: string; port: number };
  readonly stop: () => Promise<void>;
  /** Underlying node server — exposed for tests, not for production use. */
  readonly _raw: ServerType;
}

/**
 * Construct a fully-wired Clinic + HTTP app + node HTTP server and
 * bind it to the loopback interface on the configured port.
 *
 * This function is the single boot path; both the CLI and future
 * integration tests use it to get a daemon running.
 */
export async function startServer(options: StartServerOptions): Promise<RunningServer> {
  const host = options.host ?? '127.0.0.1';
  const snapshotPath = options.snapshotPath ?? defaultSnapshotPath();
  const shutdownGraceMs = options.shutdownGraceMs ?? 5000;

  // 1. Load any persisted state.
  let priorSnapshot: ClinicSnapshot | null = null;
  try {
    priorSnapshot = await loadSnapshot(snapshotPath);
  } catch (err) {
    // Loud failure: a malformed snapshot is strictly worse than no
    // snapshot. Don't silently boot with an empty state.
    throw new Error(
      `Refusing to start: snapshot at '${snapshotPath}' exists but is not loadable.\n` +
        `Cause: ${err instanceof Error ? err.message : String(err)}\n` +
        `If you really want to start fresh, delete the file and try again.`,
    );
  }

  // 2. Construct the single Clinic with the sniffed routing tier.
  const routing = resolveRoutingOptions(
    options.routingMode ?? 'auto',
    process.env,
    options.llmOverrides ?? {},
  );
  const clinicOptions = {
    ...routing.options,
    ...(priorSnapshot?.spaces ? { initialSpaces: priorSnapshot.spaces } : {}),
    ...(priorSnapshot?.inbox ? { initialInbox: priorSnapshot.inbox } : {}),
    ...(priorSnapshot?.corrections
      ? { correctionOptions: { corrections: priorSnapshot.corrections } }
      : {}),
  };
  const clinic = new Clinic(clinicOptions);

  // Warn loudly when the user asked for a premium tier but we had
  // to fall back. Silent degradation at install time is exactly the
  // class of surprise that makes dogfood misleading.
  const requestedMode = options.routingMode ?? 'auto';
  if (
    (requestedMode === 'llm' && routing.picked !== 'llm') ||
    (requestedMode === 'embedding' && routing.picked !== 'embedding')
  ) {
    // eslint-disable-next-line no-console
    console.warn(
      JSON.stringify({
        event: 'routing_tier_fallback',
        requested: requestedMode,
        picked: routing.picked,
        hint:
          "Set DOCTOR_CHAOS_LLM_BASE_URL + DOCTOR_CHAOS_LLM_API_KEY " +
          '(and optionally DOCTOR_CHAOS_LLM_MODEL, DOCTOR_CHAOS_LLM_FORMAT) ' +
          'or fall back to OPENAI_API_KEY to enable the higher tier.',
      }),
    );
  }

  // 3. Persistence callback — write-through after every mutation.
  const persist: PersistFn = async (c) => {
    await writeSnapshot(snapshotPath, c.snapshot());
  };

  // 4. Build the HTTP app and bind.
  const app = createHttpApp({ clinic, persist });
  const httpServer = serve({
    fetch: app.fetch,
    port: options.port,
    hostname: host,
  });

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      event: 'server_started',
      host,
      port: options.port,
      snapshot_path: snapshotPath,
      restored_spaces: priorSnapshot?.spaces.length ?? 0,
      restored_inbox_messages: priorSnapshot?.inbox.totalMessageCount ?? 0,
      routing_tier: routing.picked,
      ...(routing.llmConfig !== undefined
        ? {
            llm_base_url: routing.llmConfig.baseUrl,
            llm_model: routing.llmConfig.model,
            llm_format: routing.llmConfig.format,
            llm_source: routing.llmConfig.source,
          }
        : {}),
    }),
  );

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    // 1. Stop accepting new connections.
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
      // Hard timeout — if something holds the server open past the
      // grace window, we exit anyway.
      setTimeout(resolve, shutdownGraceMs).unref();
    });
    // 2. Best-effort final snapshot write.
    try {
      await writeSnapshot(snapshotPath, clinic.snapshot());
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        JSON.stringify({
          event: 'final_snapshot_write_failed',
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ event: 'server_stopped' }));
  };

  return {
    address: { host, port: options.port },
    stop,
    _raw: httpServer,
  };
}
