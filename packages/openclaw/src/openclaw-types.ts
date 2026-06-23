/**
 * Local mirror of the subset of OpenClaw's `ContextEngine` contract that this
 * plugin implements.
 *
 * Why mirror instead of importing from the OpenClaw SDK?
 *  - The plugin must `pnpm build` standalone in this monorepo, without
 *    OpenClaw installed as a dependency.
 *  - At OpenClaw runtime, structural typing makes our class assignable to the
 *    host's real `ContextEngine` interface as long as the shapes match.
 *
 * Source of truth: openclaw/openclaw `src/context-engine/types.ts`. Keep these
 * in sync if OpenClaw's contract changes. Only the four required methods
 * (`info`, `ingest`, `assemble`, `compact`) plus the optional `afterTurn` /
 * `bootstrap` we actually use are mirrored here.
 */

/** OpenClaw message shape (minimal). `content` may be a string or structured. */
export interface AgentMessage {
  role: string;
  content: unknown;
  [key: string]: unknown;
}

export interface AssembleResult {
  /** Ordered messages to use as model context for this request. */
  messages: AgentMessage[];
  /** Estimated total tokens in the assembled context. */
  estimatedTokens: number;
  /** Optional instructions prepended to the runtime system prompt. */
  systemPromptAddition?: string;
}

export interface IngestResult {
  /** Whether the message was ingested (false if duplicate or no-op). */
  ingested: boolean;
}

export interface CompactResult {
  ok: boolean;
  compacted: boolean;
  reason?: string;
}

export interface ContextEngineInfo {
  id: string;
  name: string;
  version?: string;
  /** True when the engine manages its own compaction lifecycle. */
  ownsCompaction?: boolean;
}

/** LLM completion capability optionally provided by the host runtime. */
export interface ContextEngineRuntimeContext {
  tokenBudget?: number;
  currentTokenCount?: number;
  llm?: {
    complete: (params: unknown) => Promise<unknown>;
  };
  [key: string]: unknown;
}

export interface IngestParams {
  sessionId: string;
  sessionKey?: string;
  message: AgentMessage;
  isHeartbeat?: boolean;
}

export interface AssembleParams {
  sessionId: string;
  sessionKey?: string;
  messages: AgentMessage[];
  tokenBudget?: number;
  model?: string;
  /** The incoming user prompt for this turn (useful for routing engines). */
  prompt?: string;
}

export interface CompactParams {
  sessionId: string;
  sessionKey?: string;
  sessionFile?: string;
  tokenBudget?: number;
  force?: boolean;
  currentTokenCount?: number;
}

export interface AfterTurnParams {
  sessionId: string;
  sessionKey?: string;
  sessionFile?: string;
  messages: AgentMessage[];
  prePromptMessageCount?: number;
  isHeartbeat?: boolean;
  tokenBudget?: number;
  runtimeContext?: ContextEngineRuntimeContext;
}

export interface BootstrapParams {
  sessionId: string;
  sessionKey?: string;
  sessionFile?: string;
}

export interface BootstrapResult {
  bootstrapped: boolean;
  importedMessages?: number;
  reason?: string;
}

/**
 * The pluggable context-management contract. Required: `info`, `ingest`,
 * `assemble`, `compact`. Optional methods (`bootstrap`, `afterTurn`, ...) are
 * implemented as the plugin grows.
 */
export interface ContextEngine {
  readonly info: ContextEngineInfo;
  ingest(params: IngestParams): Promise<IngestResult>;
  assemble(params: AssembleParams): Promise<AssembleResult>;
  compact(params: CompactParams): Promise<CompactResult>;
  bootstrap?(params: BootstrapParams): Promise<BootstrapResult>;
  afterTurn?(params: AfterTurnParams): Promise<void>;
}

/** Runtime context passed to a context-engine factory by OpenClaw. */
export interface ContextEngineFactoryContext {
  config?: unknown;
  agentDir?: string;
  workspaceDir?: string;
}

export type ContextEngineFactory = (
  ctx: ContextEngineFactoryContext,
) => ContextEngine | Promise<ContextEngine>;
