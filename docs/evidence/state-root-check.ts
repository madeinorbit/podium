/**
 * Check a rig-only state-root calculation against the product's resolver.
 *
 * The shell environment computes a path only so it can seed credentials and
 * inspect evidence. It must never make that path the product's
 * PODIUM_STATE_DIR. This check is run before the runtime config writer and
 * refuses both a drift in the calculation and a path override that survived
 * the environment scrub.
 */
import {
  applyInstanceRuntimeEnv,
  instanceStateDir,
  resolveInstanceId,
} from '@podium/runtime/instance'

const claimed = process.env.PODIUM_RIG_STATE_ROOT
if (!claimed) {
  console.error('state-root-check: PODIUM_RIG_STATE_ROOT is not set — source drive-env.sh')
  process.exit(2)
}

if (!process.env.PODIUM_INSTANCE?.trim()) {
  console.error(
    'state-root-check: PODIUM_INSTANCE is not set — an evidence rig must select a named instance',
  )
  process.exit(2)
}

const inherited = process.env.PODIUM_RIG_INHERITED_PATH_OVERRIDES
if (inherited) {
  console.error(
    `state-root-check: path override(s) were inherited before the rig scrubbed them: ${inherited}\n` +
      '  This run is refused so a caller setting a product path cannot hide a real failure (POD-2856).',
  )
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
        '  A rig must leave product-selected paths alone (POD-2856).',
    )
    process.exit(2)
  }
}

const instanceId = resolveInstanceId()
const actual = instanceStateDir(instanceId)
if (actual !== claimed) {
  console.error(
    `state-root-check: the rig writes to\n    ${claimed}\n` +
      `  but instanceStateDir('${instanceId}') resolves\n    ${actual}\n` +
      '  The rig would configure a directory the daemon never reads.',
  )
  process.exit(2)
}

const probe: NodeJS.ProcessEnv = {
  HOME: process.env.HOME,
  PODIUM_INSTANCE: instanceId,
  XDG_STATE_HOME: process.env.XDG_STATE_HOME,
}
applyInstanceRuntimeEnv(instanceId, probe, actual)
console.log(`  ok  state root ${actual} (product-derived, not overridden)`)
console.log(`      the product will pick ABDUCO_SOCKET_DIR=${probe.ABDUCO_SOCKET_DIR ?? '(unset)'}`)
console.log(`      and TMUX_TMPDIR=${probe.TMUX_TMPDIR ?? '(unset)'}`)
