import { describe, expect, it } from 'vitest'
import {
  alreadyRunningMessage,
  daemonOptionsForPlan,
  helpText,
  type LaunchPlan,
  portInUseMessage,
  resolveModePlan,
  resolvePlan,
  unknownLaunchToken,
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
  it('routes named managed instances only to their own units', () => {
    expect(
      plan({ mode: 'all-in-one', persistence: 'systemd' }, [], { PODIUM_INSTANCE: 'blue' }),
    ).toEqual({
      kind: 'systemd-managed',
      units: ['podium-blue-server.service', 'podium-blue-daemon.service'],
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
    expect(plan({}, ['workflow', '--help'])).toEqual({ kind: 'workflow', args: ['--help'] })
  })
  it('approval broker: agent sessions turn management ops into requests (#410)', () => {
    const agent = { PODIUM_AGENT_RELAY: 'http://127.0.0.1:1/agent/s1' }
    expect(plan({}, ['update'], agent)).toEqual({
      kind: 'approval-request',
      op: { kind: 'update' },
    })
    expect(plan({}, ['stop'], agent)).toEqual({ kind: 'approval-request', op: { kind: 'stop' } })
    expect(plan({}, ['channel', 'edge'], agent)).toEqual({
      kind: 'approval-request',
      op: { kind: 'channel', target: 'edge' },
    })
    expect(plan({}, ['channel', 'nope'], agent)).toMatchObject({ kind: 'usage-error' })
    expect(plan({}, ['set-server', 'wss://x'], agent)).toEqual({
      kind: 'approval-request',
      op: { kind: 'set-server', target: 'wss://x' },
    })
    // status polling; outside agent sessions the command explains itself
    expect(plan({}, ['approval', 'status', 'apr_1'], agent)).toEqual({
      kind: 'approval-status',
      id: 'apr_1',
    })
    expect(plan({}, ['approval', 'status', 'apr_1'])).toMatchObject({ kind: 'usage-error' })
    // outside an agent session management ops run directly, as ever
    expect(plan({}, ['update'])).toMatchObject({ kind: 'update' })
    expect(plan({}, ['stop'])).toEqual({ kind: 'stop' })
    // work tools stay direct inside agent sessions
    expect(plan({}, ['issue', 'ready'], agent)).toEqual({ kind: 'issue', args: ['ready'] })
    expect(plan({}, ['workflow', 'checkpoint', 'complete'], agent)).toEqual({
      kind: 'workflow',
      args: ['checkpoint', 'complete'],
    })
    expect(plan({}, ['status'], agent)).toEqual({ kind: 'status' })
  })

  it('approval broker: agents can request one-off current, selected, or fresh sessions', () => {
    const agent = { PODIUM_AGENT_RELAY: 'http://127.0.0.1:1/agent/s1' }
    const at = '2026-07-17T02:00:00.000Z'
    expect(
      plan({}, ['automation', 'schedule', '--at', at, '--message', 'Continue overnight.'], agent),
    ).toEqual({
      kind: 'approval-request',
      op: {
        kind: 'automation-schedule',
        name: 'Scheduled session wakeup',
        runAt: at,
        prompt: 'Continue overnight.',
        target: { kind: 'current' },
      },
    })
    expect(
      plan(
        {},
        [
          'automation',
          'schedule',
          '--at',
          at,
          '--message',
          'Check the result.',
          '--session',
          'sess_other',
          '--name',
          'Night result check',
        ],
        agent,
      ),
    ).toMatchObject({
      kind: 'approval-request',
      op: {
        name: 'Night result check',
        target: { kind: 'session', sessionId: 'sess_other' },
      },
    })
    expect(
      plan(
        {},
        [
          'automation',
          'schedule',
          '--at',
          at,
          '--message',
          'Start a clean run.',
          '--fresh',
          '--repo',
          '/repos/podium',
          '--agent',
          'codex',
          '--model',
          'gpt-5.7',
        ],
        agent,
      ),
    ).toMatchObject({
      kind: 'approval-request',
      op: {
        target: {
          kind: 'fresh',
          repoPath: '/repos/podium',
          agentKind: 'codex',
          model: 'gpt-5.7',
        },
      },
    })
    expect(
      plan({}, ['automation', 'schedule', '--at', 'nope', '--message', 'x'], agent),
    ).toMatchObject({
      kind: 'usage-error',
    })
    expect(
      plan(
        {},
        ['automation', 'schedule', '--at', at, '--message', 'x', '--fresh', '--session', 's2'],
        agent,
      ),
    ).toMatchObject({ kind: 'usage-error' })
    expect(plan({}, ['automation', 'schedule', '--at', at, '--message', 'x'])).toMatchObject({
      kind: 'usage-error',
    })
  })

  it('agent-session detection: new name, legacy alias, and PODIUM_NO_RELAY escape hatch', () => {
    // Detection via the new PODIUM_AGENT_RELAY name.
    expect(plan({}, ['update'], { PODIUM_AGENT_RELAY: 'http://127.0.0.1:1/agent/s1' })).toEqual({
      kind: 'approval-request',
      op: { kind: 'update' },
    })
    // Legacy PODIUM_ISSUE_RELAY alone still detects an agent session (one-release alias).
    expect(plan({}, ['update'], { PODIUM_ISSUE_RELAY: 'http://127.0.0.1:1/issue/s1' })).toEqual({
      kind: 'approval-request',
      op: { kind: 'update' },
    })
    // PODIUM_NO_RELAY sheds the inherited relay → NOT an agent session → runs directly.
    expect(
      plan({}, ['update'], {
        PODIUM_NO_RELAY: '1',
        PODIUM_AGENT_RELAY: 'http://127.0.0.1:1/agent/s1',
      }),
    ).toMatchObject({ kind: 'update' })
  })

  it('rejects cross-instance inherited relay routing unless explicitly disabled', () => {
    const inherited = {
      PODIUM_AGENT_RELAY: 'http://127.0.0.1:1/agent/s1',
      PODIUM_SESSION_INSTANCE: 'blue',
      PODIUM_INSTANCE: 'green',
    }
    expect(plan({}, ['issue', 'ready'], inherited)).toMatchObject({
      kind: 'usage-error',
      message: expect.stringContaining('PODIUM_NO_RELAY=1'),
    })
    expect(plan({}, ['issue', 'ready'], { ...inherited, PODIUM_NO_RELAY: '1' })).toEqual({
      kind: 'issue',
      args: ['ready'],
    })
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

// ---------------------------------------------------------------------------
// Issue #18: `podium all --help` used to boot the full stack and SIGTERM the
// running production instance. Help, unknown-token rejection, and the
// opt-in-only takeover are pinned here.
// ---------------------------------------------------------------------------

describe('resolvePlan — help (#18)', () => {
  it('`--help` / `-h` / `help` alone → help plan, never a launch', () => {
    expect(plan({}, ['--help'])).toEqual({ kind: 'help' })
    expect(plan({}, ['-h'])).toEqual({ kind: 'help' })
    expect(plan({}, ['help'])).toEqual({ kind: 'help' })
  })
  it('`all --help` (the incident invocation) → help, even with a configured box', () => {
    expect(plan({ mode: 'all-in-one', persistence: 'systemd' }, ['all', '--help'])).toEqual({
      kind: 'help',
    })
    expect(plan({}, ['server', '--help'])).toEqual({ kind: 'help' })
    expect(plan({}, ['setup', '--join', '--help'])).toEqual({ kind: 'help' })
  })
  it('help wins over TTY setup gates and utility dispatch', () => {
    expect(plan({}, ['--help'], {}, true)).toEqual({ kind: 'help' })
    expect(plan({}, ['update', '--help'])).toEqual({ kind: 'help' })
  })
  it('sub-CLIs with their own richer help keep their --help; logs gets top-level help', () => {
    expect(plan({}, ['issue', '--help'])).toEqual({ kind: 'issue', args: ['--help'] })
    expect(plan({}, ['spec', '-h'])).toEqual({ kind: 'spec', args: ['-h'] })
    expect(plan({}, ['logs', '--help'])).toEqual({ kind: 'help' })
  })
  it('helpText names the commands and the takeover flag', () => {
    const text = helpText()
    for (const word of ['all-in-one', 'server', 'daemon', 'setup', '--takeover', 'status', 'stop'])
      expect(text).toContain(word)
  })
})

describe('resolvePlan — unknown launch tokens (#18)', () => {
  it('an unknown flag on the launch path is a usage error, not a boot', () => {
    expect(plan({}, ['all', '--halp'])).toEqual({
      kind: 'usage-error',
      message: "podium: unknown argument '--halp' (run `podium help` for usage)",
    })
  })
  it('a typo’d subcommand is a usage error, not a silent default-mode boot', () => {
    expect(plan({}, ['al'])).toMatchObject({ kind: 'usage-error' })
    expect(plan({}, ['serve'])).toMatchObject({ kind: 'usage-error' })
  })
  it('known launch tokens (and value-flag arguments) pass validation', () => {
    expect(unknownLaunchToken(['all', '--takeover'])).toBeUndefined()
    expect(unknownLaunchToken(['daemon', '--local', '--server', 'ws://h:1'])).toBeUndefined()
    expect(unknownLaunchToken(['daemon', '--pair', 'ABC', '--name', 'box'])).toBeUndefined()
    expect(unknownLaunchToken(['setup', '--reconfigure'])).toBeUndefined()
    expect(unknownLaunchToken(['--bogus'])).toBe('--bogus')
  })
})

describe('resolvePlan — takeover is opt-in (#18)', () => {
  it('a plain launch carries takeover: false', () => {
    expect(plan({}, ['all'])).toMatchObject({
      kind: 'in-process',
      claimRole: 'all-in-one',
      takeover: false,
    })
    expect(plan({ mode: 'server' }, ['server'])).toMatchObject({ takeover: false })
  })
  it('--takeover flips the flag (all modes)', () => {
    expect(plan({}, ['all', '--takeover'])).toMatchObject({
      kind: 'in-process',
      claimRole: 'all-in-one',
      takeover: true,
    })
    expect(plan({}, ['server', '--takeover'])).toMatchObject({ takeover: true })
    expect(
      plan({ mode: 'daemon', serverUrl: 'wss://relay' }, ['daemon', '--takeover']),
    ).toMatchObject({ claimRole: 'daemon', takeover: true })
  })
  it('alreadyRunningMessage names the role, pid/port, and the escape hatches', () => {
    const msg = alreadyRunningMessage('all-in-one', { pid: 4242, port: 18787 })
    expect(msg).toContain('all-in-one')
    expect(msg).toContain('pid 4242')
    expect(msg).toContain('port 18787')
    expect(msg).toContain('podium stop')
    expect(msg).toContain('--takeover')
    expect(alreadyRunningMessage('daemon', { pid: 7 })).not.toContain('port')
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
      installGrokHooks: true,
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
      installGrokHooks: true,
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
