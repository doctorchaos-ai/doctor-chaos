export type {
  ClusteringStrategy,
  RoutingStrategy,
  SignalDetecting,
  TimeDecayCalculating,
} from './interfaces.js';

export type { EmbedFunction, LLMFunction } from './llm-types.js';

export { ExponentialTimeDecay } from './exponential-time-decay.js';
export { KeywordSignalDetector, defaultSignalLexicon } from './keyword-signal-detector.js';
export type { SignalLexicon } from './keyword-signal-detector.js';
export {
  KeywordMatchingStrategy,
  NEW_TOPIC_MAX_EXISTING_SCORE,
} from './keyword-matching-strategy.js';
export {
  TfIdfMatchingStrategy,
  NEW_TOPIC_MAX_EXISTING_SCORE as TFIDF_NEW_TOPIC_MAX_EXISTING_SCORE,
} from './tfidf-matching-strategy.js';
export { KeywordClusteringStrategy } from './keyword-clustering-strategy.js';
export { LLMRoutingStrategy, llmRouting } from './llm-routing-strategy.js';
export type { LLMRoutingStrategyOptions } from './llm-routing-strategy.js';
export { EmbedRoutingStrategy, embedRouting } from './embed-routing-strategy.js';
export type { EmbedRoutingStrategyOptions } from './embed-routing-strategy.js';
