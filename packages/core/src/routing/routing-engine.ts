import {
  defaultRoutingConfiguration,
  type RoutingConfiguration,
} from '../config/routing-configuration.js';
import { ExponentialTimeDecay } from '../strategies/exponential-time-decay.js';
import type {
  ClusteringStrategy,
  RoutingStrategy,
  SignalDetecting,
  TimeDecayCalculating,
} from '../strategies/interfaces.js';
import { TfIdfMatchingStrategy } from '../strategies/tfidf-matching-strategy.js';
import { KeywordSignalDetector } from '../strategies/keyword-signal-detector.js';
import type { Fragment } from '../types/fragment.js';
import type { TopicSpace } from '../types/topic-space.js';

/**
 * Where a routing decision says a message should go.
 *
 * - `existingTopicSpace`: land it in an already-open topic space.
 * - `newTopicSpace`: open a new topic space with the suggested name.
 * - `inbox`: stash it in the {@link InboxSpace} as a fragment,
 *   potentially to be clustered into a new space later.
 */
export type RoutingDestination =
  | { kind: 'existingTopicSpace'; topicSpace: TopicSpace }
  | { kind: 'newTopicSpace'; suggestedName: string }
  | { kind: 'inbox' };

/**
 * The full output of a routing decision — where to go, how confident
 * we are, and why.
 *
 * The `reasoning` string is primarily for debugging, logging, and for
 * correction learners that want to know which code path produced the
 * decision. It is intentionally human-readable English so that host
 * applications can surface it in error reports or diagnostic UI.
 */
export interface RoutingDecision {
  readonly destination: RoutingDestination;
  readonly confidence: number;
  readonly reasoning: string;
}

/**
 * Options for constructing a {@link RoutingEngine}.
 *
 * All fields are optional: the defaults give you the zero-dependency
 * MVP (keyword matching + signal detection + exponential decay), which
 * is enough to get `route()` returning sensible answers today.
 *
 * To upgrade to embeddings or a smarter NLU, swap these out by passing
 * strategies from adapter packages.
 */
export interface RoutingEngineOptions {
  readonly matchingStrategy?: RoutingStrategy;
  readonly signalDetector?: SignalDetecting;
  readonly timeDecay?: TimeDecayCalculating;
  readonly configuration?: RoutingConfiguration;
  /**
   * Optional clustering strategy. Not used by `route()` itself, but
   * carried on the engine so host applications can schedule packaging
   * passes through one coherent object.
   */
  readonly clusteringStrategy?: ClusteringStrategy;
}

/**
 * The Doctor Chaos routing engine.
 *
 * ## Design principles
 *
 * 1. **Always decides.** `route()` never returns "ask the user". It is
 *    the host application's prerogative to surface a "confirm move?"
 *    dialog, but routing itself is deterministic: given the same
 *    inputs it produces the same output, and it always picks *some*
 *    destination.
 *
 * 2. **Signal first, similarity second.** A fast signal detector
 *    short-circuits the expensive similarity computation for obvious
 *    cases (explicit continuation cues, trivia). Only ambiguous
 *    `normal` messages trigger the full space-by-space scoring.
 *
 * 3. **Recency is a first-class multiplier.** A topic that was active
 *    an hour ago beats one that was active last month, even if the
 *    keyword match is identical. This matches user expectation and
 *    falls out of the time-decay factor.
 *
 * 4. **Async signature, sync internals for now.** `route()` is async
 *    so that future embedding-backed strategies that call out to an
 *    LLM/embedding API do not force a breaking change on host apps.
 *    The default implementation resolves synchronously.
 */
export class RoutingEngine {
  private readonly matchingStrategy: RoutingStrategy;
  private readonly signalDetector: SignalDetecting;
  private readonly timeDecay: TimeDecayCalculating;
  private readonly configuration: RoutingConfiguration;
  readonly clusteringStrategy?: ClusteringStrategy;

  constructor(options: RoutingEngineOptions = {}) {
    this.configuration = options.configuration ?? defaultRoutingConfiguration;
    this.matchingStrategy =
      options.matchingStrategy ?? new TfIdfMatchingStrategy(this.configuration);
    this.signalDetector = options.signalDetector ?? new KeywordSignalDetector();
    this.timeDecay = options.timeDecay ?? new ExponentialTimeDecay(this.configuration);
    if (options.clusteringStrategy !== undefined) {
      this.clusteringStrategy = options.clusteringStrategy;
    }
  }

  /**
   * Decide where an incoming user message belongs.
   *
   * @param message           - The raw text of the incoming message.
   * @param existingSpaces    - All topic spaces currently known to the
   *                            host application (active, dormant, or
   *                            archived — filtering happens inside).
   * @param inboxFragments    - The current inbox contents. Included in
   *                            the signature so future strategies can
   *                            consider inbox context when routing;
   *                            the default keyword strategy ignores
   *                            it.
   * @param now               - The reference "now" used for time
   *                            decay. Defaults to `new Date()`.
   *                            Tests and replays pass a fixed value.
   */
  async route(
    message: string,
    existingSpaces: readonly TopicSpace[],
    inboxFragments: readonly Fragment[] = [],
    now: Date = new Date(),
  ): Promise<RoutingDecision> {
    void inboxFragments; // reserved for future strategies
    const signal = this.signalDetector.detectSignal(message);

    switch (signal.kind) {
      case 'strong':
        return this.routeStrong(message, existingSpaces);

      case 'trivial':
        return {
          destination: { kind: 'inbox' },
          confidence: 0.9,
          reasoning: 'Trivial signal (weather/time/utility query); parked in inbox.',
        };

      case 'weak':
        return {
          destination: { kind: 'inbox' },
          confidence: 0.8,
          reasoning: 'Weak signal (vague one-off request); parked in inbox.',
        };

      case 'normal':
        return this.routeBySimilarity(message, existingSpaces, now);
    }
  }

  /**
   * Handle the `strong` signal path.
   *
   * The message contains an explicit continuation cue. We route to the
   * best-matching active space, breaking ties by recency. If no active
   * space matches at all, we still fall back to the most-recently
   * active one — a strong signal by definition wants a real space,
   * not the inbox.
   */
  private async routeStrong(
    message: string,
    spaces: readonly TopicSpace[],
  ): Promise<RoutingDecision> {
    const active = spaces.filter((s) => s.status === 'active');
    if (active.length === 0) {
      return {
        destination: { kind: 'inbox' },
        confidence: 0.5,
        reasoning: 'Strong signal but no active topic spaces; fell back to inbox.',
      };
    }

    const scored = await Promise.all(
      active.map(async (space) => ({
        space,
        relevance: await this.matchingStrategy.relevanceScore(message, space),
      })),
    );

    const matching = scored.filter((s) => s.relevance > 0);
    if (matching.length > 0) {
      matching.sort(
        (a, b) => b.space.lastActivityDate.getTime() - a.space.lastActivityDate.getTime(),
      );
      const best = matching[0]!.space;
      return {
        destination: { kind: 'existingTopicSpace', topicSpace: best },
        confidence: 0.95,
        reasoning: `Strong signal + keyword match on the most recently active space (“${best.name}”).`,
      };
    }

    // No keyword hit — go with plain recency.
    const sorted = [...active].sort(
      (a, b) => b.lastActivityDate.getTime() - a.lastActivityDate.getTime(),
    );
    const best = sorted[0]!;
    return {
      destination: { kind: 'existingTopicSpace', topicSpace: best },
      confidence: 0.7,
      reasoning: `Strong signal without keyword match; defaulted to the most recently active space (“${best.name}”).`,
    };
  }

  /**
   * Handle the `normal` signal path.
   *
   * Score every active space with `relevance × timeDecay` and route to
   * the best if it clears the confidence threshold. Otherwise, ask the
   * matching strategy whether the message is substantive enough to
   * seed a brand-new space; if not, park it in the inbox.
   */
  private async routeBySimilarity(
    message: string,
    spaces: readonly TopicSpace[],
    now: Date,
  ): Promise<RoutingDecision> {
    const active = spaces.filter((s) => s.status === 'active');

    const scored = await Promise.all(
      active.map(async (space) => {
        const relevance = await this.matchingStrategy.relevanceScore(message, space);
        const decay = this.timeDecay.decayFactor(space.lastActivityDate, now);
        return { space, weightedScore: relevance * decay };
      }),
    );

    let best: { space: TopicSpace; weightedScore: number } | undefined;
    for (const candidate of scored) {
      if (!best || candidate.weightedScore > best.weightedScore) {
        best = candidate;
      }
    }

    if (best && best.weightedScore > this.configuration.confidenceThreshold) {
      return {
        destination: { kind: 'existingTopicSpace', topicSpace: best.space },
        confidence: best.weightedScore,
        reasoning: `Similarity score ${best.weightedScore.toFixed(2)} exceeds threshold ${this.configuration.confidenceThreshold}; routed to “${best.space.name}”.`,
      };
    }

    if (await this.matchingStrategy.isNewTopicWorthy(message, active)) {
      return {
        destination: { kind: 'newTopicSpace', suggestedName: suggestNewTopicName(message) },
        confidence: 0.6,
        reasoning: 'No matching space and message is substantive enough to seed a new topic.',
      };
    }

    const bestScore = best?.weightedScore ?? 0;
    return {
      destination: { kind: 'inbox' },
      confidence: 1 - bestScore,
      reasoning: `Best match score ${bestScore.toFixed(2)} below threshold ${this.configuration.confidenceThreshold}; parked in inbox.`,
    };
  }
}

/**
 * Produce a short, human-readable name suggestion for a freshly-created
 * topic space. Deliberately simple: the first 30 characters of the
 * message, trimmed, with an ellipsis if truncated. A future enhancement
 * would call an LLM; this version is zero-dependency.
 */
function suggestNewTopicName(message: string): string {
  const max = 30;
  const trimmed = message.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max).trimEnd()}…`;
}
