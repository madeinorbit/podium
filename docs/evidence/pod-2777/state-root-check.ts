/**
 * Assert the rig's idea of the state root is the PRODUCT'S idea of it.
 *
 * drive-env.sh no longer exports PODIUM_STATE_DIR (POD-2856's rule: a rig may
 * not relocate what the product picks), but the rig still has to write two
 * first-run files into that root, so it computes the path itself. Two
 * computations of one path is exactly the drift that produces a rig writing its
 * config into a directory the daemon never reads — a failure that presents as
 * "the instance came up unconfigured" and names nothing.
 *
 * So the rig's value is checked against `instanceStateDir()` itself rather than
 * against a copy of its rule. It also prints what the product chooses for
 * ABDUCO_SOCKET_DIR and TMUX_TMPDIR, and REFUSES if either was already set on
 * the way in — an inherited override is the same defect as a declared one, and
 * this shell runs inside a Podium session on the default instance.
 */
import { instanceStateDir, applyInstanceRuntimeEnv, resolveInstanceId } from '../../../packages/runtime/src/instance.ts'

const claimed = process.env.P2777_STATE_ROOT
if (!claimed) {
  console.error('state-root-check: P2777_STATE_ROOT is not set — source drive-env.sh')
  process.exit(2)
}

for (const name of [
  'ABDUCO_SOCKET_DIR',
  'TMUX_TMPDIR',
  'PODIUM_STATE_DIR',
  'PODIUM_AGENT_HOME',
] as const) {
  if (process.env[name]) {
    console.error(
      `state-root-check: ${name}=${process.env[name]} is set.\n` +
        '  This rig must not shorten or relocate a product path (POD-2856). An override\n' +
        '  here pre-empts the composition under test — which is how POD-2853 (a named\n' +
        '  instance cannot start any terminal session) went unseen for a week.',
    )
    process.exit(2)
  }
}

const inherited = process.env.PODIUM_RIG_INHERITED_PATH_OVERRIDES
if (inherited) {
  console.error(
    'state-root-check: path override(s) were inherited before the rig scrubbed them: ' +
      inherited +
      '\n' +
      '  This run is refused so a caller setting a product path cannot hide a real failure (POD-2856).',
  )
  process.exit(2)
}

const instanceId = resolveInstanceId()
// Compute with PODIUM_STATE_DIR provably absent, so the product's DERIVED rule
// is what answers rather than an override echoing back at us.
const actual = instanceStateDir(instanceId)
if (actual !== claimed) {
  console.error(
    `state-root-check: the rig writes to\n    ${claimed}\n` +
      `  but instanceStateDir('${instanceId}') resolves\n    ${actual}\n` +
      '  The rig would configure a directory the daemon never reads.',
  )
  process.exit(2)
}

// What applyInstanceRuntimeEnv will fill in, on a throwaway env so this check
// cannot itself become the thing that sets them.
const probe: NodeJS.ProcessEnv = { HOME: process.env.HOME, PODIUM_INSTANCE: instanceId }
applyInstanceRuntimeEnv(instanceId, probe, actual)
const sock = probe.ABDUCO_SOCKET_DIR ?? '(unset — default instance keeps ~/.abduco)'
console.log(`  ok  state root ${actual} (product-derived, not overridden)`)
console.log(`      the product will pick ABDUCO_SOCKET_DIR=${sock}`)
console.log(`      and TMUX_TMPDIR=${probe.TMUX_TMPDIR ?? '(unset)'}`)
