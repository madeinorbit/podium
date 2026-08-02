/**
 * `podium machine list/show` (POD-1424) — the read a coordinating agent needs before
 * placing work on a second host.
 */
import { machineByRef } from '@podium/issue-client'
import { describe, expect, it, vi } from 'vitest'
import {
  lastSeenDescription,
  MachineCliError,
  type MachineRow,
  renderMachines,
  runMachineCli,
  selectMachine,
} from './machine-cli'

const INVENTORY = {
  os: 'linux',
  arch: 'x64',
  podiumVersion: '1.2.3',
  agents: [
    { kind: 'claude-code', installed: true, version: '2.0', login: { state: 'in' as const } },
    { kind: 'codex', installed: true, login: { state: 'out' as const } },
    { kind: 'grok', installed: false, login: { state: 'unknown' as const } },
  ],
}

const HERE: MachineRow = {
  id: 'm-here',
  name: 'ludovico',
  hostname: 'ludovico',
  online: true,
  lastSeenAt: '2026-08-02T12:00:00.000Z',
  use: 'granted',
  inventory: INVENTORY,
}

const THERE: MachineRow = {
  id: 'm-there',
  name: 'quiet-box',
  hostname: 'vmi3407763.contaboserver.net',
  online: false,
  lastSeenAt: '2026-08-01T12:00:00.000Z',
  use: 'granted',
}

const NOW = Date.parse('2026-08-02T12:30:00.000Z')

const REPOS = [
  { machineId: 'm-here', path: '/home/mgw/src/podium' },
  { machineId: 'm-there', path: '/home/till/src/podium' },
]

function client(view: unknown = { machines: [HERE, THERE], repos: REPOS }) {
  const query = vi.fn(async (): Promise<unknown> => view)
  return { client: { machines: { listWithRepos: { query } } }, query }
}

describe('podium machine list', () => {
  it('reports the four facts a placement decision needs', async () => {
    const out = await runMachineCli([], client().client, NOW)
    // Liveness, use, harnesses (installed AND logged in), and the checkout — a machine
    // missing any one of them cannot take the work, and the point of the command is not
    // having to discover that by trying.
    expect(out).toContain('ludovico — online · use granted')
    expect(out).toContain('linux/x64 · podium 1.2.3')
    expect(out).toContain('claude-code 2.0: ready')
    expect(out).toContain('codex: installed, NOT logged in')
    expect(out).toContain('grok: not installed')
    expect(out).toContain('repos: /home/mgw/src/podium')
  })

  it('dates an offline machine so you can tell stale from merely idle', async () => {
    const out = await runMachineCli([], client().client, NOW)
    expect(out).toContain('quiet-box (vmi3407763.contaboserver.net) — offline')
    expect(out).toContain('(1d ago)')
  })

  it('reads the fleet in ONE call, not a machine list plus an unscoped repo list', async () => {
    const { client: c, query } = client()
    await runMachineCli([], c, NOW)
    // Two calls would mean the paths came from repos.listDetailed, which returns every
    // row on every machine regardless of who is asking.
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('says so plainly when nothing is visible', async () => {
    const out = await runMachineCli([], client({ machines: [], repos: [] }).client, NOW)
    expect(out).toBe('No machines are visible to this session.')
  })

  it('--json passes the server payload through verbatim', async () => {
    const out = await runMachineCli(['list', '--json'], client().client, NOW)
    expect(JSON.parse(out)).toEqual({
      command: 'machine list',
      ok: true,
      data: { machines: [HERE, THERE], repos: REPOS },
    })
  })
})

/**
 * THE SUBSTITUTION NO AUTHORIZATION TEST CAN CATCH.
 *
 * A machine the caller may only SEE arrives with no repo rows, and so does a machine
 * with none registered. The wire is byte-identical in both cases, so nothing on the
 * server side can tell them apart after the fact — the renderer is the only place the
 * distinction survives, which is why the `use` field is carried even while it holds one
 * value. Collapsing it would state a fact about the MACHINE when only a fact about the
 * CALLER is known.
 */
describe('empty repos: a fact about the caller vs a fact about the machine', () => {
  const seeOnly: MachineRow = { ...THERE, use: 'denied' }
  const usableButBare: MachineRow = { ...THERE, use: 'granted' }

  it('a see-only machine reports its repos as unavailable, not as absent', async () => {
    const out = await runMachineCli([], client({ machines: [seeOnly], repos: [] }).client, NOW)
    expect(out).toContain('repos: not available to this session')
    expect(out).not.toContain('none registered')
  })

  it('a usable machine with no checkouts reports them as absent, and says what to do', async () => {
    const out = await runMachineCli(
      [],
      client({ machines: [usableButBare], repos: [] }).client,
      NOW,
    )
    expect(out).toContain('repos: none registered — work cannot be placed here until one is')
    expect(out).not.toContain('repos: not available')
  })

  it('an absent inventory is reported the same way, for the same reason', async () => {
    const out = await runMachineCli([], client({ machines: [seeOnly], repos: [] }).client, NOW)
    expect(out).toContain('inventory: not available to this session')
    expect(out).not.toContain('harnesses: none reported')
  })
})

describe('podium machine show', () => {
  it('selects by id, by name and by hostname', () => {
    expect(selectMachine([HERE, THERE], 'm-there').id).toBe('m-there')
    expect(selectMachine([HERE, THERE], 'quiet-box').id).toBe('m-there')
    expect(selectMachine([HERE, THERE], 'vmi3407763.contaboserver.net').id).toBe('m-there')
  })

  it('refuses a near-miss instead of guessing which host was meant', () => {
    // Prefix matching here would start real work on a host nobody named.
    expect(() => selectMachine([HERE, THERE], 'quiet')).toThrow(MachineCliError)
    expect(() => selectMachine([HERE, THERE], 'quiet')).toThrow(/visible: ludovico, quiet-box/)
    expect(machineByRef([HERE, THERE], 'quiet')).toBeUndefined()
    expect(machineByRef([HERE, THERE], 'ludovic')).toBeUndefined()
  })

  it('id wins over a name that collides with a different machine id', () => {
    const collide: MachineRow = { ...HERE, id: 'quiet-box', name: 'decoy' }
    expect(machineByRef([collide, THERE], 'quiet-box')?.name).toBe('decoy')
  })

  it('shows one machine, with only its own checkouts', async () => {
    const out = await runMachineCli(['show', 'ludovico'], client().client, NOW)
    expect(out).toContain('ludovico — online')
    expect(out).toContain('/home/mgw/src/podium')
    expect(out).not.toContain('/home/till/src/podium')
    expect(out).not.toContain('quiet-box')
  })
})

describe('argument handling', () => {
  it('rejects an unknown command, option, or stray argument', async () => {
    const c = client().client
    await expect(runMachineCli(['destroy'], c, NOW)).rejects.toThrow(/unknown command 'destroy'/)
    await expect(runMachineCli(['list', '--wat'], c, NOW)).rejects.toThrow(/unknown option '--wat'/)
    await expect(runMachineCli(['list', 'extra'], c, NOW)).rejects.toThrow(/unexpected argument/)
    await expect(runMachineCli(['show'], c, NOW)).rejects.toThrow(/usage: podium machine show/)
  })

  it('--help renders without touching the server', async () => {
    const { client: c, query } = client()
    expect(await runMachineCli(['--help'], c, NOW)).toContain('podium machine <command>')
    expect(query).not.toHaveBeenCalled()
  })
})

describe('lastSeenDescription', () => {
  it('is coarse on purpose and never invents a negative age', () => {
    expect(lastSeenDescription('2026-08-02T12:29:30.000Z', NOW)).toContain('just now')
    // Coarse: an hour-old machine reads "1h ago", not "1h 30m ago". Whether an offline
    // host is worth waiting for does not turn on the minutes.
    expect(lastSeenDescription('2026-08-02T11:00:00.000Z', NOW)).toContain('(1h ago)')
    expect(lastSeenDescription('2026-07-22T12:00:00.000Z', NOW)).toContain('11d ago')
    // A target clock ahead of ours must not render as "in the future" nonsense.
    expect(lastSeenDescription('2026-08-03T12:00:00.000Z', NOW)).toBe(
      'last seen 2026-08-03T12:00:00.000Z',
    )
    expect(lastSeenDescription('not-a-date', NOW)).toBe('last seen not-a-date')
  })
})

describe('renderMachines', () => {
  it('separates machines into readable blocks', () => {
    const out = renderMachines([HERE, THERE], REPOS, NOW)
    expect(out.split('\n\n')).toHaveLength(2)
  })
})
