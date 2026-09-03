import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeJoin } from '@podium/runtime/join'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type InstallFinishOptions,
  parseInstallFinishArgs,
  runInstallFinish,
} from './install-finish'
import { scriptedIO } from './setup-ui'

const priorStateDir = process.env.PODIUM_STATE_DIR!

describe('parseInstallFinishArgs', () => {
  const req = ['--dest', '/d', '--bin', '/b', '--command', 'podium']
  const ok = (argv: string[], env: NodeJS.ProcessEnv = {}) => {
    const r = parseInstallFinishArgs(argv, env)
    if ('error' in r) throw new Error(`unexpected parse error: ${r.error}`)
    return r
  }

  it('defaults the channel, instance, agents and interactivity', () => {
    expect(ok(req)).toMatchObject({
      channel: 'stable',
      instance: 'default',
      dest: '/d',
      bin: '/b',
      command: 'podium',
      agents: [],
      vps: false,
      modifyPath: true,
      interactive: true,
    })
  })

  it('reads the join token from the ENVIRONMENT, never argv [R6]', () => {
    // A live pairing code in argv is readable by every other user on the box through
    // /proc/*/cmdline. We control both sides of this call, so it travels in the environment.
    expect(ok(req, { PODIUM_JOIN_TOKEN: 'tok' }).joinToken).toBe('tok')
    const viaArgv = parseInstallFinishArgs([...req, '--join', 'tok'], {})
    expect(viaArgv).toEqual({ error: expect.stringContaining('--join') })
  })

  it('parses the flags install.sh passes', () => {
    const o = ok([
      ...req,
      '--channel',
      'edge',
      '--instance',
      'work',
      '--agents',
      'codex,claude-code',
      '--vps',
      '--no-modify-path',
      '--no-interactive',
    ])
    expect(o).toMatchObject({
      channel: 'edge',
      instance: 'work',
      agents: ['codex', 'claude-code'],
      vps: true,
      modifyPath: false,
      interactive: false,
    })
  })

  it('accepts --managed and --shared and changes nothing [R10]', () => {
    // Inert by decision — POD-3309 owns whether they should mean anything.
    expect(ok([...req, '--managed'])).toEqual(ok([...req, '--shared']))
    expect(ok([...req, '--managed'])).toEqual(ok(req))
  })

  it('rejects an unknown flag and a missing required one', () => {
    expect(parseInstallFinishArgs([...req, '--nope'], {})).toEqual({
      error: expect.stringContaining('--nope'),
    })
    expect(parseInstallFinishArgs(['--dest', '/d'], {})).toEqual({
      error: expect.stringContaining('--bin'),
    })
  })

  it('rejects a channel that is not stable or edge', () => {
    expect(parseInstallFinishArgs([...req, '--channel', 'nightly'], {})).toEqual({
      error: expect.stringContaining('nightly'),
    })
  })
})

describe('runInstallFinish', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-finish-'))
    process.env.PODIUM_STATE_DIR = dir
  })
  afterEach(() => {
    process.env.PODIUM_STATE_DIR = priorStateDir
    rmSync(dir, { recursive: true, force: true })
  })

  const opts = (over: Partial<InstallFinishOptions> = {}): InstallFinishOptions => ({
    channel: 'stable',
    instance: 'default',
    dest: join(dir, 'payload'),
    bin: join(dir, 'bin'),
    command: 'podium',
    agents: [],
    vps: false,
    modifyPath: true,
    interactive: true,
    ...over,
  })

  const deps = (over: Record<string, unknown> = {}) => ({
    applyChannel: vi.fn(),
    persistPath: vi.fn(() => ({ written: [], persisted: true })),
    probeSupervision: vi.fn(() => ({ systemd: true })),
    installAgents: vi.fn(async () => []),
    runJoinSetup: vi.fn(async () => ({
      name: 'box',
      result: { effectivePersistence: 'systemd' as const, message: 'started' },
    })),
    runCliSetup: vi.fn(async () => {}),
    runVpsSetup: vi.fn(async () => {}),
    isTTY: () => true,
    home: dir,
    port: 18787,
    ...over,
  })

  it('persists the update channel BEFORE any other step [R4]', async () => {
    const order: string[] = []
    const d = deps({
      applyChannel: vi.fn(() => order.push('channel')),
      persistPath: vi.fn(() => {
        order.push('path')
        return { written: [], persisted: true }
      }),
      probeSupervision: vi.fn(() => {
        order.push('supervision')
        return { systemd: true }
      }),
    })
    const { io } = scriptedIO([])
    await runInstallFinish(io, opts({ interactive: false }), d)
    expect(order[0]).toBe('channel')
    expect(d.applyChannel).toHaveBeenCalledWith('stable')
  })

  it('pairs without prompting when a join token is present [R6]', async () => {
    const token = encodeJoin({ v: 1, serverUrl: 'wss://relay.example', pairCode: 'P1' })
    const d = deps()
    const { io, prompts } = scriptedIO([])
    await runInstallFinish(io, opts({ joinToken: token }), d)
    expect(d.runJoinSetup).toHaveBeenCalledWith(token, 'systemd', 18787)
    expect(d.runCliSetup).not.toHaveBeenCalled()
    expect(prompts).toEqual([])
  })

  it('pairs as detached when this host cannot supervise [R6]', async () => {
    const token = encodeJoin({ v: 1, serverUrl: 'wss://relay.example', pairCode: 'P1' })
    const d = deps({ probeSupervision: vi.fn(() => ({ systemd: false, why: 'no bus' })) })
    const { io } = scriptedIO([])
    await runInstallFinish(io, opts({ joinToken: token }), d)
    expect(d.runJoinSetup).toHaveBeenCalledWith(token, 'detached', 18787)
  })

  it('runs the interactive setup on a TTY with no join token [R7]', async () => {
    const d = deps()
    const { io } = scriptedIO([])
    await runInstallFinish(io, opts(), d)
    expect(d.runCliSetup).toHaveBeenCalled()
    expect(d.runVpsSetup).not.toHaveBeenCalled()
  })

  it('selects the VPS flow under --vps [R7]', async () => {
    const d = deps()
    const { io } = scriptedIO([])
    await runInstallFinish(io, opts({ vps: true }), d)
    expect(d.runVpsSetup).toHaveBeenCalled()
    expect(d.runCliSetup).not.toHaveBeenCalled()
  })

  it('never prompts without a TTY, and points at podium setup instead [R8]', async () => {
    const d = deps({ isTTY: () => false })
    const { io, prompts, commands } = scriptedIO([])
    await runInstallFinish(io, opts(), d)
    expect(d.runCliSetup).not.toHaveBeenCalled()
    expect(prompts).toEqual([])
    expect(commands).toContain('podium')
  })

  it('honours --no-interactive even on a TTY [R8]', async () => {
    const d = deps({ isTTY: () => true })
    const { io } = scriptedIO([])
    await runInstallFinish(io, opts({ interactive: false }), d)
    expect(d.runCliSetup).not.toHaveBeenCalled()
  })

  it('skips PATH persistence under --no-modify-path', async () => {
    const d = deps()
    const { io } = scriptedIO([])
    await runInstallFinish(io, opts({ modifyPath: false, interactive: false }), d)
    expect(d.persistPath).not.toHaveBeenCalled()
  })

  it('renders every copyable command through command(), never as prose [R9]', async () => {
    const token = encodeJoin({ v: 1, serverUrl: 'wss://relay.example', pairCode: 'P1' })
    const d = deps()
    const { io, commands } = scriptedIO([])
    await runInstallFinish(io, opts({ joinToken: token, command: 'podium-work' }), d)
    expect(commands).toContain('podium-work status')
    expect(commands).toContain('podium-work stop')
  })

  it('boxes the PATH export when this shell cannot yet see the command [R9]', async () => {
    const d = deps({
      persistPath: vi.fn(() => ({ written: ['/h/.profile'], persisted: true })),
      pathOf: () => '/usr/bin:/bin', // bin dir absent from PATH
    })
    const { io, commands } = scriptedIO([])
    await runInstallFinish(io, opts({ interactive: false }), d)
    expect(commands.some((c) => c.startsWith('export PATH='))).toBe(true)
  })

  it('installs only the requested agents, and none when none were asked for', async () => {
    const d = deps()
    const { io } = scriptedIO([])
    await runInstallFinish(io, opts({ interactive: false }), d)
    expect(d.installAgents).not.toHaveBeenCalled()

    const d2 = deps()
    const { io: io2 } = scriptedIO([])
    await runInstallFinish(io2, opts({ interactive: false, agents: ['codex'] }), d2)
    expect(d2.installAgents).toHaveBeenCalledWith(io2, ['codex'], join(dir, 'bin'))
  })

  it('pairs BEFORE installing agents, so a slow download cannot expire the code', async () => {
    // install.sh:430-441 ordered these deliberately: a one-use join code is short-lived, and
    // fetching three vendor CLIs onto a bare machine is slow enough to outlast one.
    const order: string[] = []
    const token = encodeJoin({ v: 1, serverUrl: 'wss://relay.example', pairCode: 'P1' })
    const d = deps({
      runJoinSetup: vi.fn(async () => {
        order.push('join')
        return {
          name: 'box',
          result: { effectivePersistence: 'systemd' as const, message: '' },
        }
      }),
      installAgents: vi.fn(async () => {
        order.push('agents')
        return []
      }),
    })
    const { io } = scriptedIO([])
    await runInstallFinish(io, opts({ joinToken: token, agents: ['codex'] }), d)
    expect(order).toEqual(['join', 'agents'])
  })

  it('does not install agents when the join failed — there is nothing to install them for', async () => {
    const token = encodeJoin({ v: 1, serverUrl: 'wss://relay.example', pairCode: 'P1' })
    const d = deps({
      runJoinSetup: vi.fn(async () => {
        throw new Error('pairing code already used')
      }),
    })
    const { io } = scriptedIO([])
    await expect(
      runInstallFinish(io, opts({ joinToken: token, agents: ['codex'] }), d),
    ).rejects.toThrow()
    expect(d.installAgents).not.toHaveBeenCalled()
  })

  it('says what supervision the host will actually get, when it is not systemd', async () => {
    const d = deps({
      probeSupervision: vi.fn(() => ({
        systemd: false,
        why: 'this host does not run systemd',
        fix: 'add an "@reboot" entry with `crontab -e`',
      })),
    })
    const { io, output } = scriptedIO([])
    await runInstallFinish(io, opts({ interactive: false }), d)
    const all = output.join('\n')
    expect(all).toContain('does not run systemd')
    expect(all).toContain('crontab -e')
  })

  it('reports a failed join without pretending the machine is ready', async () => {
    const token = encodeJoin({ v: 1, serverUrl: 'wss://relay.example', pairCode: 'P1' })
    const d = deps({
      runJoinSetup: vi.fn(async () => {
        throw new Error('pairing code already used')
      }),
    })
    const { io, output } = scriptedIO([])
    await expect(runInstallFinish(io, opts({ joinToken: token }), d)).rejects.toThrow(
      'pairing code already used',
    )
    expect(output.join('\n')).not.toContain('joined your Podium')
  })
})
