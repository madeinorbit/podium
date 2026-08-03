import { asMachineId, type MachineWire, machineByRef } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import {
  lastSeenDescription,
  MachineCliError,
  type MachineClient,
  machineHelpText,
  renderMachines,
  runMachineCli,
  selectMachine,
} from './machine-cli'

const NOW = Date.parse('2026-08-02T12:00:00.000Z')

const ludovico: MachineWire = {
  id: asMachineId('m-ludovico'),
  name: 'ludovico',
  hostname: 'ludovico',
  online: true,
  lastSeenAt: '2026-08-02T11:59:00.000Z',
  use: 'granted',
  inventory: {
    os: 'linux',
    arch: 'x64',
    podiumVersion: '0.1.2-edge.1',
    agents: [
      {
        kind: 'claude-code',
        installed: true,
        version: '2.0.1',
        login: { state: 'in', account: 'a@example.com' },
      },
      { kind: 'codex', installed: true, version: '1.4.0', login: { state: 'out' } },
      { kind: 'grok', installed: false, login: { state: 'unknown' } },
    ],
    tools: [],
  },
}

const quiet: MachineWire = {
  id: asMachineId('m-quiet'),
  name: 'quiet-box',
  hostname: 'quiet-box.example.net',
  online: false,
  lastSeenAt: '2026-07-22T12:00:00.000Z',
  use: 'granted',
}

const repos = [
  { machineId: 'm-ludovico', path: '/home/mgw/src/podium' },
  { machineId: 'm-ludovico', path: '/home/mgw/src/other' },
]

function fakeClient(machines: MachineWire[], repoRows = repos): MachineClient {
  return { machines: { listWithRepos: { query: async () => ({ machines, repos: repoRows }) } } }
}

/** A machine this principal can SEE but not USE: the server drops both its
 *  inventory and its repo rows, so the view must not turn either absence into a
 *  claim about the machine. */
const seeOnly: MachineWire = {
  id: asMachineId('m-theirs'),
  name: 'someone-elses-box',
  hostname: 'someone-elses-box',
  online: true,
  lastSeenAt: '2026-08-02T11:59:00.000Z',
  use: 'denied',
}

describe('renderMachines', () => {
  it('reports liveness, use decision, harness readiness and registered repos', () => {
    const out = renderMachines([ludovico], repos, NOW)
    expect(out).toContain('ludovico — online · use granted')
    expect(out).toContain('linux/x64 · podium 0.1.2-edge.1')
    expect(out).toContain('claude-code 2.0.1: ready (a@example.com)')
    expect(out).toContain('codex 1.4.0: installed, NOT logged in')
    expect(out).toContain('grok: not installed')
    expect(out).toContain('repos: /home/mgw/src/podium, /home/mgw/src/other')
  })

  it('names the age of an offline machine and the absence of a repo', () => {
    const out = renderMachines([quiet], repos, NOW)
    expect(out).toContain('quiet-box (quiet-box.example.net) — offline · use granted')
    expect(out).toContain('last seen 2026-07-22T12:00:00.000Z (11d ago)')
    expect(out).toContain('repos: none registered')
  })

  it('does not report a see-only machine as having no repos', () => {
    // The absence of repo rows for a `use: denied` machine says nothing about the
    // machine — only about this caller. Both strings are legal output; only one
    // is true here, and the wire cannot tell them apart.
    const out = renderMachines([seeOnly], repos, NOW)
    expect(out).toContain('repos: not available to this session')
    expect(out).not.toContain('none registered')
  })

  it('says inventory is unavailable rather than inventing an empty one', () => {
    // A `see`-only principal gets identity and liveness with the inventory field
    // dropped by the server projection. Rendering that as "no harnesses" would
    // read as a fact about the machine instead of a fact about the caller.
    const out = renderMachines([quiet], repos, NOW)
    expect(out).toContain('inventory: not available to this session')
    expect(out).not.toContain('harnesses:')
  })

  it('has something to say when nothing is visible', () => {
    expect(renderMachines([], [], NOW)).toBe('No machines are visible to this session.')
  })
})

describe('selectMachine', () => {
  it('matches on id, name and hostname', () => {
    expect(selectMachine([ludovico, quiet], 'm-quiet')).toBe(quiet)
    expect(selectMachine([ludovico, quiet], 'quiet-box')).toBe(quiet)
    expect(selectMachine([ludovico, quiet], 'quiet-box.example.net')).toBe(quiet)
  })

  it('refuses a near-miss instead of guessing which host was meant', () => {
    expect(() => selectMachine([ludovico, quiet], 'quiet')).toThrow(MachineCliError)
    expect(() => selectMachine([ludovico, quiet], 'quiet')).toThrow(/visible: ludovico, quiet-box/u)
  })

  it('id wins over a name that collides with a different machine id', () => {
    const decoy: MachineWire = { ...ludovico, id: asMachineId('quiet-box'), name: 'decoy' }
    expect(machineByRef([decoy, quiet], 'quiet-box')?.name).toBe('decoy')
  })
})

describe('lastSeenDescription', () => {
  it('is coarse on purpose and never invents a negative age', () => {
    expect(lastSeenDescription('2026-08-02T11:59:30.000Z', NOW)).toContain('just now')
    // Coarse: an hour-old machine reads "1h ago", not "1h 30m ago". Whether an offline
    // host is worth waiting for does not turn on the minutes.
    expect(lastSeenDescription('2026-08-02T10:30:00.000Z', NOW)).toContain('(1h ago)')
    expect(lastSeenDescription('2026-07-22T12:00:00.000Z', NOW)).toContain('11d ago')
    // A target clock ahead of ours must not render as "in the future" nonsense.
    expect(lastSeenDescription('2026-08-03T12:00:00.000Z', NOW)).toBe(
      'last seen 2026-08-03T12:00:00.000Z',
    )
    expect(lastSeenDescription('not-a-date', NOW)).toBe('last seen not-a-date')
  })
})

describe('runMachineCli', () => {
  it('lists by default and under an explicit `list`', async () => {
    const bare = await runMachineCli([], fakeClient([ludovico, quiet]), NOW)
    const explicit = await runMachineCli(['list'], fakeClient([ludovico, quiet]), NOW)
    expect(bare).toBe(explicit)
    expect(bare).toContain('ludovico')
    expect(bare).toContain('quiet-box')
  })

  it('reads the fleet in ONE call, not a machine list plus an unscoped repo list', async () => {
    const query = vi.fn(async () => ({ machines: [ludovico, quiet], repos }))
    await runMachineCli([], { machines: { listWithRepos: { query } } }, NOW)
    // Two calls would mean the paths came from repos.listDetailed, which returns every
    // row on every machine regardless of who is asking.
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('shows one machine, and only that machine', async () => {
    const out = await runMachineCli(['show', 'quiet-box'], fakeClient([ludovico, quiet]), NOW)
    expect(out).toContain('quiet-box')
    expect(out).not.toContain('ludovico')
  })

  it('emits the server payload verbatim under --json', async () => {
    const out = await runMachineCli(['list', '--json'], fakeClient([ludovico]), NOW)
    expect(JSON.parse(out)).toEqual({
      command: 'machine list',
      ok: true,
      data: { machines: [ludovico], repos },
    })
  })

  it('rejects an unknown subcommand, an unknown option and a missing selector', async () => {
    const client = fakeClient([ludovico])
    await expect(runMachineCli(['reboot'], client, NOW)).rejects.toThrow(
      /unknown command 'reboot'/u,
    )
    await expect(runMachineCli(['list', '--all'], client, NOW)).rejects.toThrow(
      /unknown option '--all'/u,
    )
    await expect(runMachineCli(['show'], client, NOW)).rejects.toThrow(
      /usage: podium machine show/u,
    )
    await expect(runMachineCli(['list', 'extra'], client, NOW)).rejects.toThrow(
      /unexpected argument 'extra'/u,
    )
  })

  it('answers --help without reaching the server', async () => {
    const exploding: MachineClient = {
      machines: {
        listWithRepos: {
          query: async () => {
            throw new Error('must not be called')
          },
        },
      },
    }
    expect(await runMachineCli(['--help'], exploding, NOW)).toBe(machineHelpText())
  })
})
