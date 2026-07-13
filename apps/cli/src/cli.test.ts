import { describe, expect, it } from 'vitest'
import {
  daemonOptionsForPlan,
  type LaunchPlan,
  portInUseMessage,
  resolveModePlan,
  resolvePlan,
} from './cli'

describe('resolveModePlan', () => {
  it('defaults to all-in-one + setup hint when nothing is configured', () => {
    expect(resolveModePlan([], {})).toEqual({ mode: 'all-in-one', showSetupHint: true })
  })
  it('uses the configured mode when present', () => {
    expect(resolveModePlan([], { mode: 'server' })).toEqual({
      mode: 'server',
      showSetupHint: false,
    })
  })
  it('an explicit subcommand overrides config', () => {
    expect(resolveModePlan(['daemon'], { mode: 'all-in-one' })).toMatchObject({ mode: 'daemon' })
  })
  it('--server flag is carried into the plan', () => {
    expect(resolveModePlan(['daemon', '--server', 'ws://h:1'], {})).toMatchObject({
      mode: 'daemon',
      serverUrl: 'ws://h:1',
    })
  })
  it('config.serverUrl is used when no flag', () => {
    expect(resolveModePlan(['daemon'], { serverUrl: 'ws://cfg:1' })).toMatchObject({
      serverUrl: 'ws://cfg:1',
    })
  })
  it('--pair and --name are carried into the plan for a fresh remote daemon', () => {
    expect(
      resolveModePlan(
        ['daemon', '--server', 'ws://h:1', '--pair', 'ABC123', '--name', 'laptop'],
        {},
      ),
    ).toEqual({
      mode: 'daemon',
      serverUrl: 'ws://h:1',
      pairCode: 'ABC123',
      name: 'laptop',
      showSetupHint: false,
    })
  })
  it('--pair and --name are absent when not passed', () => {
    const plan = resolveModePlan(['daemon', '--server', 'ws://h:1'], {})
    expect(plan).not.toHaveProperty('pairCode')
    expect(plan).not.toHaveProperty('name')
  })
  it('daemon pairCode falls back to config.pairCode when no --pair flag', () => {
    expect(
      resolveModePlan(['daemon'], { serverUrl: 'ws://cfg:1', pairCode: 'CFG999' }),
    ).toMatchObject({
      mode: 'daemon',
      serverUrl: 'ws://cfg:1',
      pairCode: 'CFG999',
    })
  })
  it('--pair flag wins over config.pairCode', () => {
    expect(
      resolveModePlan(['daemon', '--pair', 'FLAG1'], {
        serverUrl: 'ws://cfg:1',
        pairCode: 'CFG999',
      }),
    ).toMatchObject({ pairCode: 'FLAG1' })
  })
})

// ---------------------------------------------------------------------------
// resolvePlan — the one pure launch resolver. These tests PIN current behavior
// across the mode × persistence × pendingPersistence × TTY matrix (#251).
// ---------------------------------------------------------------------------

/** resolvePlan with quiet defaults: empty env, no TTY (the headless/systemd baseline). */
function plan(
  config: Parameters<typeof resolvePlan>[0],
  argv: string[] = [],
  env: Record<string, string | undefined> = {},
  tty = false,
): LaunchPlan {
  return resolvePlan(config, argv, env, tty)
}

describe('resolvePlan — launch matrix', () => {
  it('systemd-recorded box, bare invocation → start both units (all-in-one)', () => {
    expect(plan({ mode: 'all-in-one', persistence: 'systemd' })).toEqual({
      kind: 'systemd-managed',
      units: ['podium-server.service', 'podium-daemon.service'],
    })
  })
  it('systemd-recorded server box → server unit only; daemon box → daemon unit only', () => {
    expect(plan({ mode: 'server', persistence: 'systemd' })).toEqual({
      kind: 'systemd-managed',
      units: ['podium-server.service'],
    })
    expect(plan({ mode: 'daemon', serverUrl: 'wss://relay', persistence: 'systemd' })).toEqual({
      kind: 'systemd-managed',
      units: ['podium-daemon.service'],
    })
  })
  it('detached-recorded box, bare invocation → ensure the detached split is up', () => {
    expect(plan({ mode: 'all-in-one', persistence: 'detached' })).toEqual({
      kind: 'detached-managed',
      port: 18787,
    })
  })
  it('explicit component subcommand on a managed box runs in-process (it IS a component)', () => {
    const p = plan({ mode: 'all-in-one', persistence: 'systemd' }, ['server'])
    expect(p).toMatchObject({
      kind: 'in-process',
      roles: { server: true, daemon: false },
      claimRole: 'server',
    })
  })
  it('desktop sidecar: configured mode, no persistence, non-TTY bare → in-process all-in-one', () => {
    expect(plan({ mode: 'all-in-one' })).toMatchObject({
      kind: 'in-process',
      roles: { server: true, daemon: true },
      claimRole: 'all-in-one',
      daemonAuth: 'in-process-local',
      runRecordMode: 'foreground',
      showSetupHint: false,
    })
  })
  it('incomplete headless config (mode, no persistence) on a TTY → routed back into setup', () => {
    expect(plan({ mode: 'all-in-one' }, [], {}, true)).toEqual({
      kind: 'interactive-setup',
      port: 18787,
      reason: 'incomplete-headless-config',
    })
  })
  it('pendingPersistence recorded by the web setup → reconcile (even without a TTY)', () => {
    expect(plan({ mode: 'all-in-one', pendingPersistence: 'systemd' })).toEqual({
      kind: 'reconcile-pending-persistence',
      port: 18787,
    })
    // ...and reconcile wins over the setup gate on a TTY too.
    expect(plan({ mode: 'server', pendingPersistence: 'detached' }, [], {}, true)).toEqual({
      kind: 'reconcile-pending-persistence',
      port: 18787,
    })
  })
  it('pendingPersistence with an unreconcilable mode falls through (mirrors the runtime check)', () => {
    expect(
      plan({ mode: 'client', serverUrl: 'wss://relay', pendingPersistence: 'systemd' }),
    ).toEqual({ kind: 'client', serverUrl: 'wss://relay' })
  })
  it('pendingPersistence + an explicit subcommand is NOT reconciled (component run)', () => {
    expect(plan({ mode: 'all-in-one', pendingPersistence: 'systemd' }, ['server'])).toMatchObject({
      kind: 'in-process',
      claimRole: 'server',
    })
  })
  it('fresh box on a TTY → first-run interactive setup', () => {
    expect(plan({}, [], {}, true)).toEqual({
      kind: 'interactive-setup',
      port: 18787,
      reason: 'first-run',
    })
  })
  it('fresh box without a TTY → in-process all-in-one serving the setup hint', () => {
    expect(plan({})).toMatchObject({
      kind: 'in-process',
      roles: { server: true, daemon: true },
      claimRole: 'all-in-one',
      showSetupHint: true,
    })
  })
  it('`podium setup` on a TTY → explicit interactive setup, any mode', () => {
    expect(plan({ mode: 'all-in-one', persistence: 'systemd' }, ['setup'], {}, true)).toEqual({
      kind: 'interactive-setup',
      port: 18787,
      reason: 'explicit',
    })
  })
  it('`podium setup` without a TTY → serve the web setup UI: server only, NO registry claim', () => {
    expect(plan({ mode: 'all-in-one', persistence: 'systemd' }, ['setup'])).toMatchObject({
      kind: 'in-process',
      roles: { server: true, daemon: false },
      claimRole: undefined,
      showSetupHint: true,
    })
  })
  it('client mode → client plan with the configured serverUrl', () => {
    expect(plan({ mode: 'client', serverUrl: 'wss://relay' })).toEqual({
      kind: 'client',
      serverUrl: 'wss://relay',
    })
  })
  it('`podium daemon --local` (split daemon on a host box) → local-split auth', () => {
    expect(
      plan({ mode: 'all-in-one', persistence: 'systemd' }, ['daemon', '--local']),
    ).toMatchObject({
      kind: 'in-process',
      roles: { server: false, daemon: true },
      claimRole: 'daemon',
      daemonAuth: 'local-split',
    })
  })
  it('`podium daemon` against a remote server → remote auth (blocked-exit wiring)', () => {
    expect(plan({ mode: 'daemon', serverUrl: 'wss://relay' }, ['daemon'])).toMatchObject({
      kind: 'in-process',
      roles: { server: false, daemon: true },
      daemonAuth: 'remote',
    })
  })
  it('run record mode: NOTIFY_SOCKET → systemd; PODIUM_RUN_MODE=detached → detached', () => {
    expect(plan({ mode: 'server' }, ['server'], { NOTIFY_SOCKET: '/run/x' })).toMatchObject({
      runRecordMode: 'systemd',
    })
    expect(plan({ mode: 'server' }, ['server'], { PODIUM_RUN_MODE: 'detached' })).toMatchObject({
      runRecordMode: 'detached',
    })
    expect(plan({ mode: 'server' }, ['server'])).toMatchObject({ runRecordMode: 'foreground' })
  })
  it('port precedence: PODIUM_PORT env > config.port > 18787', () => {
    expect(plan({ mode: 'all-in-one', port: 2000 }, [], { PODIUM_PORT: '3000' })).toMatchObject({
      port: 3000,
    })
    expect(plan({ mode: 'all-in-one', port: 2000 })).toMatchObject({ port: 2000 })
    expect(plan({ mode: 'all-in-one' })).toMatchObject({ port: 18787 })
  })
})

describe('resolvePlan — utility subcommands', () => {
  it('update: channel precedence env > config > stable; feed env > config', () => {
    expect(plan({}, ['update'])).toEqual({
      kind: 'update',
      channel: 'stable',
      feedOverride: undefined,
    })
    expect(plan({ updateChannel: 'edge', updateFeed: 'http://cfg' }, ['update'])).toEqual({
      kind: 'update',
      channel: 'edge',
      feedOverride: 'http://cfg',
    })
    expect(
      plan({ updateChannel: 'edge', updateFeed: 'http://cfg' }, ['update'], {
        PODIUM_UPDATE_CHANNEL: 'stable',
        PODIUM_UPDATE_FEED: 'http://env',
      }),
    ).toEqual({ kind: 'update', channel: 'stable', feedOverride: 'http://env' })
  })
  it('help: help/--help/-h anywhere, except the sub-CLIs that render their own', () => {
    expect(plan({}, ['help'])).toEqual({ kind: 'help' })
    expect(plan({}, ['--help'])).toEqual({ kind: 'help' })
    expect(plan({}, ['-h'])).toEqual({ kind: 'help' })
    expect(plan({}, ['daemon', '--help'])).toEqual({ kind: 'help' })
    expect(plan({}, ['issue', '--help'])).toEqual({ kind: 'issue', args: ['--help'] })
    expect(plan({}, ['spec', '-h'])).toEqual({ kind: 'spec', args: ['-h'] })
    expect(plan({}, ['session', '--help'])).toEqual({ kind: 'session', args: ['--help'] })
    expect(plan({}, ['worktree', '--help'])).toEqual({ kind: 'worktree', args: ['--help'] })
  })
  it('version: version/--version/-v', () => {
    expect(plan({}, ['version'])).toEqual({ kind: 'version' })
    expect(plan({}, ['--version'])).toEqual({ kind: 'version' })
    expect(plan({}, ['-v'])).toEqual({ kind: 'version' })
  })
  it('channel: with and without a target', () => {
    expect(plan({}, ['channel'])).toEqual({ kind: 'channel', target: undefined })
    expect(plan({}, ['channel', 'edge'])).toEqual({ kind: 'channel', target: 'edge' })
  })
  it('join-config: token required', () => {
    expect(plan({}, ['join-config', 'TOK'])).toEqual({ kind: 'join-config', token: 'TOK' })
    expect(plan({}, ['join-config'])).toEqual({
      kind: 'usage-error',
      message: 'usage: podium join-config <TOKEN>',
    })
  })
  it('set-server: target required', () => {
    expect(plan({}, ['set-server', 'wss://x'])).toEqual({ kind: 'set-server', target: 'wss://x' })
    expect(plan({}, ['set-server'])).toMatchObject({ kind: 'usage-error' })
  })
  it('setup --repair wins over the interactive flow', () => {
    expect(plan({}, ['setup', '--repair'], {}, true)).toEqual({ kind: 'repair-config' })
  })
  it('setup --join: token + persist validation + port resolution', () => {
    expect(plan({ port: 2000 }, ['setup', '--join', 'TOK'])).toEqual({
      kind: 'join-setup',
      token: 'TOK',
      persistence: 'systemd',
      port: 2000,
    })
    expect(plan({}, ['setup', '--join', 'TOK', '--persist', 'detached'])).toMatchObject({
      kind: 'join-setup',
      persistence: 'detached',
    })
    expect(plan({}, ['setup', '--join'])).toMatchObject({ kind: 'usage-error' })
    expect(plan({}, ['setup', '--join', 'TOK', '--persist', 'nohup'])).toEqual({
      kind: 'usage-error',
      message: "podium setup --persist must be systemd or detached (got 'nohup')",
    })
  })
  it('issue/spec/worktree/logs carry their remaining args', () => {
    expect(plan({}, ['issue', 'list', '--all'])).toEqual({ kind: 'issue', args: ['list', '--all'] })
    expect(plan({}, ['spec', 'show'])).toEqual({ kind: 'spec', args: ['show'] })
    expect(plan({}, ['worktree', '/x'])).toEqual({ kind: 'worktree', args: ['/x'] })
    expect(plan({}, ['logs', '-f'])).toEqual({ kind: 'logs', args: ['-f'] })
  })
  it('status/stop', () => {
    expect(plan({}, ['status'])).toEqual({ kind: 'status' })
    expect(plan({}, ['stop'])).toEqual({ kind: 'stop' })
  })
})

describe('daemonOptionsForPlan', () => {
  it('authenticates all-in-one daemon as the local machine', () => {
    expect(
      daemonOptionsForPlan({ mode: 'all-in-one', showSetupHint: false }, 18787, 'local-secret'),
    ).toEqual({
      serverUrl: 'ws://localhost:18787',
      bootstrapToken: 'local-secret',
      machineId: 'local',
      installCodexHooks: true,
    })
  })

  it('keeps remote daemon auth based on serverUrl and pair code', () => {
    expect(
      daemonOptionsForPlan(
        {
          mode: 'daemon',
          serverUrl: 'wss://relay.example',
          pairCode: 'PAIR1',
          showSetupHint: false,
        },
        18787,
        'local-secret',
      ),
    ).toEqual({
      serverUrl: 'wss://relay.example',
      pairCode: 'PAIR1',
      installCodexHooks: true,
    })
  })
})

describe('portInUseMessage', () => {
  it('names the port and points at the already-running server instead of a stack trace', () => {
    const msg = portInUseMessage(18787)
    expect(msg).toContain('18787')
    expect(msg.toLowerCase()).toContain('already')
    expect(msg).toContain('http://localhost:18787')
  })
})
