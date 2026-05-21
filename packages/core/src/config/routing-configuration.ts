/**
 * Tunable parameters for the router and clustering engine.
 *
 * Most host applications will be well served by {@link defaultRoutingConfiguration}.
 * Tune individual fields only when profiling shows the default is a bad
 * fit for the specific conversation shape of the application.
 *
 * All thresholds are expressed in "obvious units" (seconds, days,
 * counts) rather than opaque numbers — readability beats micro-efficiency
 * at configuration time.
 */
export interface RoutingConfiguration {
  /**
   * The minimum weighted similarity score a message must earn to be
   * routed into an existing topic space (as opposed to the inbox or a
   * new space). Values in `[0, 1]`.
   *
   * Raising this makes routing more conservative (more messages land
   * in the inbox); lowering it makes routing more confident (more
   * messages join existing spaces).
   */
  readonly confidenceThreshold: number;

  /**
   * Half-life, in seconds, of the time-decay weight applied to a topic
   * space's match score. A space that was active `halfLifeSeconds` ago
   * has its score multiplied by `0.5`; twice that ago, `0.25`; and so on.
   *
   * The default half-life of 7 days tracks the intuition that a topic
   * "fades" over a week without activity but does not vanish.
   */
  readonly timeDecayHalfLifeSeconds: number;

  /**
   * Minimum number of fragments in a cluster before the packaging
   * executor is willing to promote it into a new topic space. Below
   * this, clusters are considered speculative and ignored.
   */
  readonly packagingDensityThreshold: number;

  /**
   * Number of days a topic space may remain inactive before the
   * lifecycle manager transitions it from `active` to `archived`.
   * (Dormant is a shorter-lived intermediate state used during scoring.)
   */
  readonly archiveInactivityDays: number;

  /**
   * The minimum character length of a message before it is eligible to
   * seed a brand-new topic space on its own. Shorter messages route to
   * the inbox where clustering may later include them in a cluster.
   */
  readonly newTopicMinLength: number;
}

/**
 * Sensible defaults for {@link RoutingConfiguration}.
 *
 * The values are inherited from the iOS reference implementation and
 * have been validated against realistic conversation traces.
 */
export const defaultRoutingConfiguration: RoutingConfiguration = {
  confidenceThreshold: 0.2,
  timeDecayHalfLifeSeconds: 7 * 24 * 60 * 60, // 7 days
  packagingDensityThreshold: 3,
  archiveInactivityDays: 30,
  newTopicMinLength: 20,
};
