/**
 * ARM THE ROLLOUT ROW BY BREAKING THE THING IT CHECKS (POD-2754).
 *
 * `PODIUM_UPDATE_E2E_PROVE_FAILURE=canary` runs this against the source the
 * bootstrap coordinator is built from, BEFORE that build. It seeds every
 * channel's rollout with the canary already proved, so the first tick of a wave
 * widens to the whole fleet instead of gating on one machine — the product
 * skipping the stage the row is about, in the product, rather than a flag the
 * check itself agrees to ignore.
 *
 * Everything else about the update stays correct: the machines converge, the
 * versions land, the handovers happen. Only the shape of the wave changes. That
 * is what makes it a proof that the row can say NO: a green run with this
 * applied would mean the row is checking nothing.
 *
 * It edits the seed rather than the planner because the seed is one
 * unambiguous line and the planner is the thing under test. A missing anchor is
 * a hard failure — an arming control that silently changed nothing is exactly
 * the instrument this issue exists to stop trusting.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const file = process.argv[2] ?? '/work/source/apps/server/src/modules/updates/service.ts'
const anchor = `const freshRollout = (): ChannelRolloutState => ({
  authorized: false,
  canaryHealthy: false,`
const armed = anchor.replace('canaryHealthy: false,', 'canaryHealthy: true,')

const before = readFileSync(file, 'utf8')
if (!before.includes(anchor)) {
  console.error(
    `skip-canary: the rollout seed in ${file} does not look the way this control expects`,
  )
  process.exit(1)
}
writeFileSync(file, before.replace(anchor, armed))
const after = readFileSync(file, 'utf8')
if (!after.includes(armed)) {
  console.error(`skip-canary: ${file} was not changed`)
  process.exit(1)
}
console.log(`skip-canary: ${file} now seeds every rollout with the canary already proved`)
