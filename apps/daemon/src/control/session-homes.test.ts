// SESSIONS IN HARNESS HOMES (credential management §10; epic plan Task 8,
// acceptance 2 and 10).
//
// A spawn whose access names a Podium home runs with the harness's directory
// variable pointed at that home and nowhere else; two sessions in two homes
// at once each get their own. A spawn that names no home runs as before. A
// home this machine does not hold refuses the spawn rather than starting the
// session on the machine's own login.
//
// Same seam as spawn-strip-env.test.ts: the real spawn handler, with the PTY
// layer stood in for so the options it receives can be read.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SpawnOptions } from '@podium/process/screen'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { HomeRegistry } from '../homes/registry'
import { stubDurable, testSessions, testTerminalRuntime } from '../session/testing.js'
import { memoryMarkers, SessionAccessStore } from './access'
import type { DaemonContext } from './context'

const root = mkdtempSync(join(tmpdir(), 'podium-session-homes-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const settingsDir = join(root, 'settings')
/** The person's HOME as the daemon sees it: never the test runner's own. */
const person = join(root, 'person')
mkdirSync(join(person, '.claude'), { recursive: true })
writeFileSync(join(person, '.claude', 'CLAUDE.md'), 'MARK-PERSON')
writeFileSync(
  join(person, '.claude.json'),
  JSON.stringify({ mcpServers: { mark: { command: 'm' } } }),
)

const CRED_A = 'cred_aaaaaaaa-0000-4000-8000-000000000001'
const CRED_B = 'cred_bbbbbbbb-0000-4000-8000-000000000002'

let captured: SpawnOptions[] = []
const sent: Array<Record<string, unknown>> = []

const fakeSpawn = (opts: SpawnOptions) => {
  captured.push(opts)
  return {
    pid: 4242,
    onFrame: () => () => {},
    onTitle: () => () => {},
    onExit: () => () => {},
    write: () => {},
    resize: () => {},
    dispose: () => {},
  }
}

const { launchTerminalProcess, sessionHandlers } = await import('./session')

const homes = new HomeRegistry({ root: join(root, 'state', 'homes') })

function contextForSpawn(): DaemonContext {
  const ctx = {
    send: (frame: Record<string, unknown>) => void sent.push(frame),
    instanceId: 'default',
    backend: 'none',
    durable: stubDurable(fakeSpawn),
    machineId: 'session-homes-test-machine',
    settingsDir,
    homeDir: person,
    launch: (_kind: string, opts: { cwd: string }) => ({
      cmd: '/bin/true',
      args: [],
      cwd: opts.cwd,
    }),
    sessions: testSessions(),
    durableLabelFor: (id: string) => `podium-${id}`,
    sessionBinding: { transition: async () => ({ status: 'applied' }) },
    outputScheduler: { enqueue: () => {}, remove: () => {} },
    observers: { initSessionObservers: () => {}, clearSession: () => {} },
    sessionCwdTracker: { setLaunchCwd: async () => {}, clear: () => {} },
    hookEndpointFor: (id: string) => `http://127.0.0.1:1/hook/${id}`,
    agentRelayEndpointFor: (id: string) => `http://127.0.0.1:1/relay/${id}`,
    access: new SessionAccessStore({ markers: memoryMarkers() }),
    homes,
  } as unknown as DaemonContext
  ctx.agentRuntime = testTerminalRuntime(
    ctx,
    launchTerminalProcess,
  ) as unknown as DaemonContext['agentRuntime']
  return ctx
}

const homeAccess = (credentialId: string, homeId: string) => ({
  credentialId,
  delivery: { kind: 'home' as const, homeId },
})

async function spawn(frame: Record<string, unknown>): Promise<void> {
  await sessionHandlers.spawn(contextForSpawn(), {
    type: 'spawn',
    geometry: { cols: 80, rows: 24 },
    binding: {
      transitionId: `t-${String(frame.sessionId)}`,
      machineAccess: 'allowed',
      principal: { kind: 'system', job: 'session-homes-test' },
    },
    ...frame,
  } as Parameters<typeof sessionHandlers.spawn>[1])
}

async function launched(cwd: string): Promise<SpawnOptions> {
  const start = Date.now()
  for (;;) {
    const found = captured.find((opts) => opts.cwd === cwd)
    if (found) return found
    if (Date.now() - start > 5_000) throw new Error(`no launch reached the PTY layer for ${cwd}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

beforeEach(() => {
  captured = []
  sent.length = 0
})

describe('sessions in harness homes', () => {
  it('two Claude Code sessions in two homes at once: each has its own home and not the other’s (acceptance 2)', async () => {
    const a = await homes.ensure(CRED_A, 'claude-code')
    const b = await homes.ensure(CRED_B, 'claude-code')
    await Promise.all([
      spawn({
        sessionId: 'home-a',
        agentKind: 'claude-code',
        cwd: '/repo-a',
        access: homeAccess(CRED_A, a.home.homeId),
      }),
      spawn({
        sessionId: 'home-b',
        agentKind: 'claude-code',
        cwd: '/repo-b',
        access: homeAccess(CRED_B, b.home.homeId),
      }),
    ])
    const [optsA, optsB] = await Promise.all([launched('/repo-a'), launched('/repo-b')])
    expect(optsA.env?.CLAUDE_CONFIG_DIR).toBe(a.home.dir)
    expect(optsB.env?.CLAUDE_CONFIG_DIR).toBe(b.home.dir)
    expect(JSON.stringify(optsA.env)).not.toContain(b.home.dir)
    expect(JSON.stringify(optsB.env)).not.toContain(a.home.dir)
    // The boundary must not delete the variable the home rides on.
    expect(optsA.stripEnv).not.toContain('CLAUDE_CONFIG_DIR')
    // The home is ready for a terminal: the person's instructions linked,
    // their MCP servers copied, onboarding done and the folder trusted.
    expect(readFileSync(join(a.home.dir, 'CLAUDE.md'), 'utf8')).toBe('MARK-PERSON')
    const state = JSON.parse(readFileSync(join(a.home.dir, '.claude.json'), 'utf8'))
    expect(state.hasCompletedOnboarding).toBe(true)
    expect(state.mcpServers).toEqual({ mark: { command: 'm' } })
    expect(state.projects['/repo-a']).toEqual({ hasTrustDialogAccepted: true })
  })

  it('two Codex sessions in two homes at once: each has its own CODEX_HOME (acceptance 2)', async () => {
    const a = await homes.ensure(CRED_A, 'codex')
    const b = await homes.ensure(CRED_B, 'codex')
    await Promise.all([
      spawn({
        sessionId: 'codex-a',
        agentKind: 'codex',
        cwd: '/codex-a',
        access: homeAccess(CRED_A, a.home.homeId),
      }),
      spawn({
        sessionId: 'codex-b',
        agentKind: 'codex',
        cwd: '/codex-b',
        access: homeAccess(CRED_B, b.home.homeId),
      }),
    ])
    const [optsA, optsB] = await Promise.all([launched('/codex-a'), launched('/codex-b')])
    expect(optsA.env?.CODEX_HOME).toBe(a.home.dir)
    expect(optsB.env?.CODEX_HOME).toBe(b.home.dir)
    expect(JSON.stringify(optsA.env)).not.toContain(b.home.dir)
  })

  it('a session that names no home runs in the harness’s own directory, as before (acceptance 10)', async () => {
    await spawn({ sessionId: 'plain', agentKind: 'claude-code', cwd: '/plain' })
    const opts = await launched('/plain')
    expect(opts.env?.CLAUDE_CONFIG_DIR).toBeUndefined()
    expect(opts.stripEnv).toContain('CLAUDE_CONFIG_DIR')
    await spawn({
      sessionId: 'plain-default',
      agentKind: 'codex',
      cwd: '/plain-default',
      access: homeAccess(CRED_A, 'default'),
    })
    expect((await launched('/plain-default')).env?.CODEX_HOME).toBe(join(person, '.codex'))
  })

  it('a home this machine does not hold refuses the spawn; nothing starts on the machine’s own login', async () => {
    const missing = `cred_cccccccc-0000-4000-8000-000000000003:claude-code`
    await spawn({
      sessionId: 'missing',
      agentKind: 'claude-code',
      cwd: '/missing',
      access: homeAccess('cred_cccccccc-0000-4000-8000-000000000003', missing),
    })
    const start = Date.now()
    while (!sent.some((frame) => frame.type === 'spawnError') && Date.now() - start < 5_000) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const error = sent.find((frame) => frame.type === 'spawnError')
    expect(String(error?.message)).toMatch(/home this machine does not hold/)
    expect(captured.some((opts) => opts.cwd === '/missing')).toBe(false)
    expect(
      existsSync(join(root, 'state', 'homes', 'cred_cccccccc-0000-4000-8000-000000000003')),
    ).toBe(false)
  })
})
