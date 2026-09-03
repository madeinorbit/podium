/**
 * THE DRIVER TAXONOMY — re-exported, not redefined.
 *
 * `DriverFamily`, `DriverId` and `SelectionContext` are DEFINED in
 * `@podium/harness`, beside the `AgentManifest.runtime` axis that declares them.
 * The direction is forced: this package imports harness, never the reverse, and
 * a cycle would be rejected by turbo, `declared-deps` and the layer manifest
 * alike. Keeping a second copy here and reconciling it with a test is exactly
 * the duplication the epic's own pitfall list calls its biggest long-term cost.
 *
 * So this file is an alias, and that is the whole point of it: consumers of the
 * contract import the taxonomy from the contract, while exactly one definition
 * exists.
 */

export type {
  DriverFamily,
  DriverId,
  EmbeddedRuntimeSpec,
  SelectionContext,
  ServerRuntimeSpec,
  TerminalRuntimeSpec,
} from '@podium/harness'
