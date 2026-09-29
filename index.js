/**
 * dsh-whale-sway — host half.
 *
 * The whole feature is client-side. This half exists for exactly two reasons:
 * the package's bundle layer needs a Loader row to instantiate, and the
 * manifest's `dsh.client` declaration is only discovered for a package the
 * active profile has enabled. It owns no Host service, registers no tool, holds
 * no state, and does nothing on `apply()`.
 */

/** Cordis plugin name — must match the package name and the bundle patch row. */
export const name = 'dsh-whale-sway';

/** No Host dependencies: this plugin touches nothing on the Host side. */
export const inject = [];

/** Nothing to set up and nothing to tear down. */
export function apply() {}
