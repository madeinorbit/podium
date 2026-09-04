/**
 * `podium logs daemons` / `podium logs daemon-level` — the argv a command means
 * and the sentence it prints. Pure functions, no server.
 *
 * The one behaviour worth pinning beyond parsing: a RAISE that reached nothing
 * must not read as success. A listing and a reset are honest at zero — nothing
 * connected, or a daemon that is already gone is already at its default — but a
 * raise that matched no machine has done nothing, and an operator who takes it
 * for done goes on to read an empty file and blames the pipeline.
 */

import { describe, expect, it } from 'vitest'
import { LogsLevelCliError } from './logs-level-cli'
import {
  fleetFileFor,
  parseLogsDaemonArgs,
  renderSetDaemonLevelReply,
  runLogsDaemonCli,
  type SetDaemonLevelReply,
} from './logs-daemon-cli'

const client = (reply: SetDaemonLevelReply) => {
  const calls: unknown[] = []
  return {
    calls,
    logs: {
      setDaemonLevel: {
        mutate: async (input: unknown) => {
          calls.push(input)
          return reply
        },
      },
    },
  }
}

describe('parseLogsDaemonArgs', () => {
  it('a listing is a reset with no selector', () => {
    expect(parseLogsDaemonArgs(['daemons'])).toEqual({
      kind: 'daemons',
      json: false,
      input: { level: null },
    })
  })

  it('raises one machine for a duration', () => {
    expect(parseLogsDaemonArgs(['daemon-level', 'debug', '--machine', 'flatblock', '--for', '30m']))
      .toEqual({
        kind: 'raise',
        json: false,
        input: { level: 'debug', ttlMs: 1_800_000, target: { machineId: 'flatblock' } },
      })
  })

  it('accepts --machine=<id> as well as --machine <id>', () => {
    expect(parseLogsDaemonArgs(['daemon-level', 'trace', '--machine=flatblock']).input.target)
      .toEqual({ machineId: 'flatblock' })
  })

  it('reset carries a null level', () => {
    expect(parseLogsDaemonArgs(['daemon-level', 'reset']).input).toEqual({ level: null })
  })

  it('refuses a duration on a reset, which has nothing to undo', () => {
    expect(() => parseLogsDaemonArgs(['daemon-level', 'reset', '--for', '30m'])).toThrow(
      LogsLevelCliError,
    )
  })

  it('refuses a selector on a listing, which exists to find out what to select', () => {
    expect(() => parseLogsDaemonArgs(['daemons', '--machine', 'flatblock'])).toThrow(
      LogsLevelCliError,
    )
  })

  it('refuses an unknown level rather than sending it', () => {
    expect(() => parseLogsDaemonArgs(['daemon-level', 'verbose'])).toThrow(LogsLevelCliError)
  })

  it('refuses a bare --for with no unit, whose two readings differ by 60000x', () => {
    expect(() => parseLogsDaemonArgs(['daemon-level', 'debug', '--for', '30'])).toThrow(
      LogsLevelCliError,
    )
  })
})

describe('fleetFileFor', () => {
  it('names the file the server writes, so the next command is typeable', () => {
    expect(fleetFileFor({ machineId: 'Flatblock' as never, name: 'Flatblock' })).toBe(
      'logs/fleet/flatblock.ndjson',
    )
  })
})

describe('renderSetDaemonLevelReply', () => {
  const flatblock = { machineId: 'flatblock' as never, name: 'Flatblock' }

  it('a raise names what it reached and where to read it', () => {
    const text = renderSetDaemonLevelReply(
      'raise',
      { level: 'debug', daemons: [flatblock] },
      { ttlMs: 1_800_000 },
    )

    expect(text).toContain('Raised 1 daemon to debug for 30m')
    expect(text).toContain('flatblock')
    expect(text).toContain('logs/fleet/flatblock.ndjson')
  })

  it('a raise that reached nothing says so instead of reporting success', () => {
    const text = renderSetDaemonLevelReply('raise', { level: 'debug', daemons: [] }, {})

    expect(text).toContain('No online daemon matched')
  })

  it('a listing says that listing was itself a reset', () => {
    const text = renderSetDaemonLevelReply('daemons', { level: null, daemons: [flatblock] }, {})

    expect(text).toContain('Listing IS a reset')
  })

  it('shows a drop count, which is the difference between quiet and lossy', () => {
    const text = renderSetDaemonLevelReply(
      'reset',
      { level: null, daemons: [{ ...flatblock, dropped: 12 }] },
      {},
    )

    expect(text).toContain('dropped=12')
  })
})

describe('runLogsDaemonCli', () => {
  it('a raise that reached nothing is not ok', async () => {
    const c = client({ level: 'debug', daemons: [] })

    const result = await runLogsDaemonCli(['daemon-level', 'debug'], c)

    expect(result.ok).toBe(false)
  })

  it('a listing that found nothing is ok — zero connected is an answer', async () => {
    const c = client({ level: null, daemons: [] })

    const result = await runLogsDaemonCli(['daemons'], c)

    expect(result.ok).toBe(true)
  })

  it('--json prints the reply verbatim under the command that produced it', async () => {
    const c = client({ level: 'debug', daemons: [{ machineId: 'm1' as never, name: 'M1' }] })

    const result = await runLogsDaemonCli(['daemon-level', 'debug', '--json'], c)

    expect(JSON.parse(result.text)).toEqual({
      command: 'logs daemon-level',
      ok: true,
      data: { level: 'debug', daemons: [{ machineId: 'm1', name: 'M1' }] },
    })
  })

  it('sends the level command the plan describes', async () => {
    const c = client({ level: null, daemons: [] })

    await runLogsDaemonCli(['daemons'], c)

    expect(c.calls).toEqual([{ level: null }])
  })
})
