/**
 * POD-1607 — the CLI must dial the address the server BOUND, not a hard-coded loopback.
 *
 * `resolveBindHost()` binds `PODIUM_HOST` and NOTHING else, so setting it to a real
 * interface (what you do to reach Podium from another device) leaves loopback unbound
 * and every hard-coded `http://localhost:<port>` in the CLI is refused — `podium issue
 * list` and friends fail on the host machine while a browser reaches the server fine.
 * POD-1585 fixed the bundled daemon; these are the CLI's own copies of the same bug.
 *
 * Two kinds of assertion here, because the sites have two shapes:
 *   - the composable ones (`resolvePlan`, `daemonOptionsForPlan`, `portInUseMessage`,
 *     `renderStatus`) are exercised directly;
 *   - the operator-client dials are constructed inline inside each verb's `main()`,
 *     so they are pinned by a source scan — reverting any one of them to the literal
 *     reddens this file.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { daemonOptionsForPlan, portInUseMessage, resolvePlan } from './cli'
import { renderStatus } from './cli-lifecycle'

const HOST = '100.113.194.89'

describe('local dials follow PODIUM_HOST (POD-1607)', () => {
  const saved = process.env.PODIUM_HOST
  beforeEach(() => {
    process.env.PODIUM_HOST = HOST
  })
  afterEach(() => {
    if (saved === undefined) delete process.env.PODIUM_HOST
    else process.env.PODIUM_HOST = saved
  })

  it('the janitor component dials the bound interface', () => {
    const plan = resolvePlan({ port: 23000 }, ['janitor'], { PODIUM_HOST: HOST }, false)
    expect(plan).toMatchObject({ kind: 'janitor', serverUrl: `http://${HOST}:23000` })
  })

  it('the local daemon dials the bound interface over ws', () => {
    expect(
      daemonOptionsForPlan({ mode: 'all-in-one', showSetupHint: false }, 23000, 'tok', 'mid'),
    ).toMatchObject({ serverUrl: `ws://${HOST}:23000` })
  })

  it('printed URLs name the bound address, not a localhost that would not load', () => {
    // Advice to a human: `localhost` is actively misleading once the server is
    // bound elsewhere — they would paste it into a browser and watch it fail.
    expect(portInUseMessage(23000)).toContain(`http://${HOST}:23000`)
    expect(portInUseMessage(23000)).not.toContain('localhost')
    const status = renderStatus({
      live: [],
      config: { mode: 'all-in-one', port: 23000 },
      nowMs: Date.now(),
    })
    expect(status).toContain(`URL: http://${HOST}:23000`)
  })

  it('no CLI source dials a hard-coded loopback', () => {
    // The operator-client sites (`podium issue|mail|session|agent|workflow|lock|spec`)
    // build their URL inline; this is what catches a revert of any single one.
    // cli-systemd is deliberately excluded: unit files are baked at install time and
    // run without PODIUM_HOST in their environment, so the server they name binds
    // loopback and the literal there is correct.
    const dialSites = [
      'issue-cli.ts',
      'agent-cli.ts',
      'workflow-cli.ts',
      'lock-cli.ts',
      'mail-cli.ts',
      'spec-cli.ts',
      'session-cli.ts',
      'cli.ts',
      'cli-spawn.ts',
      'cli-lifecycle.ts',
    ]
    const offenders = dialSites.filter((file) =>
      /(?:https?|wss?):\/\/localhost:\$\{/.test(readFileSync(join(__dirname, file), 'utf8')),
    )
    expect(offenders).toEqual([])
  })

  it('an unset PODIUM_HOST leaves the ordinary single-machine install on loopback', () => {
    delete process.env.PODIUM_HOST
    expect(resolvePlan({ port: 23000 }, ['janitor'], {}, false)).toMatchObject({
      serverUrl: 'http://localhost:23000',
    })
    expect(
      daemonOptionsForPlan({ mode: 'all-in-one', showSetupHint: false }, 23000, 'tok', 'mid'),
    ).toMatchObject({ serverUrl: 'ws://localhost:23000' })
    expect(portInUseMessage(23000)).toContain('http://localhost:23000')
  })
})
