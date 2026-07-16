#!/usr/bin/env bun
/**
 * The migration oracle [POD-295]: the behavioral contract every rewrite phase
 * must preserve. Lane definitions are NOT restated here — docs/agents/testing.md
 * is the source of truth [spec:SP-0be7]; this file only names which lanes the
 * oracle is made of and runs them.
 *
 * Land-flow convention (docs/rearchitecture-v3.md): acquiring the merge lock for
 * main requires a green `bun run oracle` on the candidate sha, evidence in the
 * issue. Advisory, like the lock itself — CI is the backstop, not the gate.
 *
 * The agent-smoke lane is deliberately NOT part of the oracle: it launches real
 * agent CLIs and bills LLM quota, so it runs only as an explicit gate step where
 * a phase touches harness adapters.
 */

/** Lanes constituting the oracle. `heavy` ones spawn real processes/PTYs/servers. */
export const ORACLE_LANES = [
  { name: 'typecheck', script: 'typecheck', heavy: false },
  { name: 'unit', script: 'test', heavy: false },
  { name: 'integration', script: 'test:integration', heavy: true },
  { name: 'e2e', script: 'test:e2e', heavy: true },
  { name: 'multi-instance', script: 'test:multi-instance', heavy: true },
] as const

/** Heavy lanes bind fixed ports (relay.e2e 9921, multi-machine 9922), so the
 *  sweep is SEQUENTIAL: two lanes at once on one machine collide on the port. */
export const HEAVY_LANES = ORACLE_LANES.filter((l) => l.heavy).map((l) => l.name)

type Result = { name: string; code: number; seconds: number }

async function runLane(script: string): Promise<number> {
  const proc = Bun.spawn(['bun', 'run', script], { stdout: 'inherit', stderr: 'inherit' })
  return await proc.exited
}

async function main() {
  const results: Result[] = []
  for (const lane of ORACLE_LANES) {
    console.log(`\n\x1b[1m━━━ oracle lane: ${lane.name} (bun run ${lane.script}) ━━━\x1b[0m`)
    const start = Date.now()
    // Exit code comes straight off the process — never through a pipe, which
    // would report the LAST command's status and launder a red lane green.
    const code = await runLane(lane.script)
    results.push({ name: lane.name, code, seconds: Math.round((Date.now() - start) / 1000) })
    // Deliberately no early exit: one red lane must not mask another's status.
  }

  console.log('\n\x1b[1m━━━ oracle summary ━━━\x1b[0m')
  for (const r of results) {
    const verdict = r.code === 0 ? '\x1b[32mGREEN\x1b[0m' : `\x1b[31mRED (exit ${r.code})\x1b[0m`
    console.log(`  ${r.name.padEnd(16)} ${verdict}  ${r.seconds}s`)
  }

  const red = results.filter((r) => r.code !== 0)
  if (red.length > 0) {
    console.log(`\n\x1b[31mORACLE RED\x1b[0m — ${red.map((r) => r.name).join(', ')}`)
    console.log('A red oracle blocks the merge lock for main. Fix, or quarantine with a')
    console.log('linked issue + a reason in docs/rearchitecture-v3.md — never a silent skip.')
    process.exit(1)
  }
  console.log(`\n\x1b[32mORACLE GREEN\x1b[0m — ${results.length} lanes`)
}

if (import.meta.main) await main()
