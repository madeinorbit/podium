import type { ResolvedHarnessInventory } from './inventory/build-inventory.js'

/**
 * The narrow slice of the inventory an invocation needs: the resolved
 * executable map plus the command environment it was resolved in. Named here
 * (not in the inventory) so adapters can take it as a parameter without
 * importing the inventory mechanism — the inventory snapshot satisfies it
 * structurally, so host callers pass what they hold.
 */
export type HarnessExecutableSnapshot = Pick<
  ResolvedHarnessInventory,
  'executables' | 'commandEnvironment'
>
