/**
 * Current package version, kept in sync with `package.json`.
 *
 * Lives in its own module (instead of {@link ./index.js}) so that
 * internal modules can import it without triggering the circular
 * dependency chain that would arise if they imported from the
 * package's public entry point.
 */
export const VERSION = '0.1.0-alpha.0' as const;
