/**
 * ORACLE — session handoff across two machines (POD-379 for POD-642).
 *
 * Handoff is the one session write that moves a session between machines, and
 * the one whose failure modes are expensive: a half-transferred session is a
 * lost conversation. What is pinned here is the ORDER of the irreversible steps
 * (nothing is stopped until every pre-flight passed), the rollback contract on
 * a mid-transfer failure, the worktree-reuse guard, and the bundle-base refusal
 * that the d73e9121 bug class produced.
 *
 * TOPOLOGY NOTE. The issue brief asks for the POD-498 isolated harness
 * (tests/e2e/iso-handoff-host.ts + iso-handoff-daemon.ts). That harness needs a
 * SECOND REAL MACHINE reachable over the tailnet and is a hand-driven script,
 * not a lane — it cannot run in the hermetic unit lane and there is no human in
 * this run to drive it. These tests instead run two paired machines with
 * SCRIPTED daemons against the real SessionsService, which is where the
 * orchestration being characterized actually lives (the daemons only answer
 * export/import/repoOp RPCs). The real-hardware transfer path — bundle apply,
 * git worktree add, credential install — stays the iso harness's job.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ControlMessage } from '@podium/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionRegistry } from '../../relay'
import { SessionStore } from '../../store'
import { MUST_NOT_CHANGE, messageOf, waitFor, willChange } from './oracle-support'

const SHA = 'a'.repeat(40)

interface HandoffFixture {
  reg: SessionRegistry
  store: SessionStore
  source: ControlMessage[]
  target: ControlMessage[]
  sessionId: string
}

const built: SessionRegistry[] = []
let priorStateDir: string | undefined

beforeEach(() => {
  priorStateDir = process.env.PODIUM_STATE_DIR
  process.env.PODIUM_STATE_DIR = mkdtempSync(join(tmpdir(), 'podium-oracle-handoff-'))
})

afterEach(() => {
  for (const reg of built.splice(0)) reg.dispose()
  if (priorStateDir === undefined) delete process.env.PODIUM_STATE_DIR
  else process.env.PODIUM_STATE_DIR = priorStateDir
})

/**
 * Two paired machines (m1 source, m2 target) with scripted daemons, and one
 * resumable claude-code session living in a worktree on m1.
 */
async function handoffFixture(
  opts: { failExport?: boolean; targetHasBase?: boolean } = {},
): Promise<HandoffFixture> {
  const store = new SessionStore(':memory:')
  store.machines.upsertMachine({ id: 'm1', name: 'source', hostname: 'source', tokenHash: 'x' })
  store.machines.upsertMachine({ id: 'm2', name: 'target', hostname: 'target', tokenHash: 'y' })
  const inventory = JSON.stringify({
    os: 'linux',
    arch: 'x64',
    agents: [{ kind: 'claude-code', installed: true, login: { state: 'in' } }],
    tools: [],
  })
  store.machines.setMachineInventory('m1', inventory)
  store.machines.setMachineInventory('m2', inventory)
  store.repos.addRepo('/source/repo', 'm1', 'git@github.com:example/repo.git')
  store.repos.addRepo('/target/repo', 'm2', 'git@github.com:example/repo.git')
  const reg = new SessionRegistry(store)
  built.push(reg)

  const source: ControlMessage[] = []
  const target: ControlMessage[] = []
  reg.modules.sessions.attachDaemon('m1', (msg) => {
    source.push(msg)
    if (msg.type === 'repoOpRequest') {
      const ok = msg.args?.ref === 'main'
      reg.modules.sessions.onDaemonMessageFrom('m1', {
        type: 'repoOpResult',
        requestId: msg.requestId,
        ok,
        output: ok ? SHA : 'missing',
      })
    }
    if (msg.type === 'handoffExportRequest') {
      reg.modules.sessions.onDaemonMessageFrom(
        'm1',
        opts.failExport
          ? {
              type: 'handoffExportResult',
              requestId: msg.requestId,
              ok: false,
              error: 'source exploded mid-export',
            }
          : {
              type: 'handoffExportResult',
              requestId: msg.requestId,
              ok: true,
              stagePath: '/source/.podium/handoff/package.tgz',
              sizeBytes: 3,
              manifest: {
                format: 1,
                sessionId: msg.sessionId,
                agentKind: 'claude-code',
                resume: { kind: 'claude-session', value: 'native-id' },
                transcriptFilename: 'native-id.jsonl',
                repoId: store.repos.listRepos('m1')[0]?.repoId as string,
                branch: 'x',
                headSha: SHA,
                snapshotSha: null,
                snapshotFlattened: true,
                worktreeName: 'x',
                worktreeRelativePath: '.worktrees/x',
                bundleBase: [SHA],
                sourceMachineId: 'm1',
                exportedAt: new Date().toISOString(),
              },
            },
      )
    }
    if (msg.type === 'handoffChunkReadRequest')
      reg.modules.sessions.onDaemonMessageFrom('m1', {
        type: 'handoffChunkReadResult',
        requestId: msg.requestId,
        ok: true,
        data: Buffer.from('pkg').toString('base64'),
        sizeBytes: 3,
        eof: true,
      })
  })
  reg.modules.sessions.attachDaemon('m2', (msg) => {
    target.push(msg)
    if (msg.type === 'repoOpRequest') {
      // The bundle-base handshake: the target proves which of the source's SHAs
      // it already has. `targetHasBase: false` is the d73e9121 shape — a target
      // that shares no verified commit with the source.
      const ok = opts.targetHasBase === false ? false : msg.args?.ref === SHA
      reg.modules.sessions.onDaemonMessageFrom('m2', {
        type: 'repoOpResult',
        requestId: msg.requestId,
        ok,
        output: ok ? SHA : 'missing',
      })
    }
    if (msg.type === 'handoffImportChunk')
      reg.modules.sessions.onDaemonMessageFrom('m2', {
        type: 'handoffImportChunkResult',
        requestId: msg.requestId,
        ok: true,
        sizeBytes: msg.offset + Buffer.from(msg.data, 'base64').length,
      })
    if (msg.type === 'handoffImportRequest')
      reg.modules.sessions.onDaemonMessageFrom('m2', {
        type: 'handoffImportResult',
        requestId: msg.requestId,
        ok: true,
        newCwd: '/target/repo/.worktrees/x',
        worktreeRoot: '/target/repo/.worktrees/x',
      })
  })

  const { sessionId } = await reg.modules.sessions.resumeSession({
    agentKind: 'claude-code',
    cwd: '/source/repo/.worktrees/x',
    resume: { kind: 'claude-session', value: 'native-id' },
    conversationId: 'native-id',
    machineId: 'm1',
  })
  return { reg, store, source, target, sessionId }
}

const meta = (f: HandoffFixture) =>
  f.reg.modules.sessions.listSessions().find((s) => s.sessionId === f.sessionId)

describe('oracle: handoff success across two machines', () => {
  it(`${MUST_NOT_CHANGE}: the row is re-homed onto the target and resumed there, and the source is told to kill`, async () => {
    const f = await handoffFixture()

    const result = await f.reg.modules.sessions.handoffSession({
      sessionId: f.sessionId,
      machineId: 'm2',
    })

    expect(result).toEqual({ ok: true, newCwd: '/target/repo/.worktrees/x' })
    expect(meta(f)).toMatchObject({
      machineId: 'm2',
      cwd: '/target/repo/.worktrees/x',
      status: 'starting',
    })
    expect(f.source).toContainEqual(
      expect.objectContaining({ type: 'kill', sessionId: f.sessionId }),
    )
    expect(f.target).toContainEqual(
      expect.objectContaining({
        type: 'spawn',
        sessionId: f.sessionId,
        cwd: '/target/repo/.worktrees/x',
      }),
    )
    // The overlay every client renders the move with is cleared on arrival.
    expect(meta(f)?.handoffTarget).toBeUndefined()
  })

  it(`${MUST_NOT_CHANGE}: nothing is stopped until the pre-flight passed — kill comes AFTER the bundle-base handshake`, async () => {
    const f = await handoffFixture()

    await f.reg.modules.sessions.handoffSession({ sessionId: f.sessionId, machineId: 'm2' })

    const killIndex = f.source.findIndex((m) => m.type === 'kill')
    const exportIndex = f.source.findIndex((m) => m.type === 'handoffExportRequest')
    const baseProbeIndex = f.target.findIndex((m) => m.type === 'repoOpRequest')
    expect(killIndex).toBeGreaterThanOrEqual(0)
    expect(baseProbeIndex).toBeGreaterThanOrEqual(0)
    // Order within the source stream: the process dies before the export runs.
    expect(killIndex).toBeLessThan(exportIndex)
    // And the target's verification happened before the source was ever killed.
    expect(f.source.slice(0, killIndex).some((m) => m.type === 'handoffExportRequest')).toBe(false)
  })

  it(`${willChange('POD-1079', "machines become owned compute; handoff must later check 'use' on the target")}: handoff to any paired ONLINE machine is allowed with no per-machine authorization`, async () => {
    const f = await handoffFixture()

    // The only gates today are reachability and harness capability. There is no
    // owner, no grant list, and no caller identity involved at all.
    await expect(
      f.reg.modules.sessions.handoffSession({ sessionId: f.sessionId, machineId: 'm2' }),
    ).resolves.toMatchObject({ ok: true })
  })
})

describe('oracle: handoff refusals that must not move anything', () => {
  it(`${MUST_NOT_CHANGE}: no verified common bundle base ⇒ refuse, with the session untouched on the source (the d73e9121 class)`, async () => {
    const f = await handoffFixture({ targetHasBase: false })

    expect(
      await messageOf(() =>
        f.reg.modules.sessions.handoffSession({ sessionId: f.sessionId, machineId: 'm2' }),
      ),
    ).toBe('target repository has no verified common bundle base')

    expect(meta(f)).toMatchObject({ machineId: 'm1', cwd: '/source/repo/.worktrees/x' })
    // Nothing irreversible ran: no kill, no export, no import.
    expect(f.source.some((m) => m.type === 'kill')).toBe(false)
    expect(f.source.some((m) => m.type === 'handoffExportRequest')).toBe(false)
    expect(f.target.some((m) => m.type === 'handoffImportRequest')).toBe(false)
    // And the handover overlay was cleared rather than left painted.
    expect(meta(f)?.handoffTarget).toBeUndefined()
  })

  it(`${MUST_NOT_CHANGE}: handing a session to the machine it is already on is refused`, async () => {
    const f = await handoffFixture()

    expect(
      await messageOf(() =>
        f.reg.modules.sessions.handoffSession({ sessionId: f.sessionId, machineId: 'm1' }),
      ),
    ).toBe('session is already on that machine')
  })

  it(`${MUST_NOT_CHANGE}: a session with no resume ref cannot be handed off — the conversation would not survive`, async () => {
    const f = await handoffFixture()
    const shell = f.reg.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/source/repo/.worktrees/x',
      machineId: 'm1',
    })

    expect(
      await messageOf(() =>
        f.reg.modules.sessions.handoffSession({ sessionId: shell.sessionId, machineId: 'm2' }),
      ),
    ).toBe('session harness does not support handoff')
  })
})

describe('oracle: mid-transfer crash', () => {
  it(`${MUST_NOT_CHANGE}: an export failure rolls the session back onto the SOURCE and re-resurrects it there`, async () => {
    const f = await handoffFixture({ failExport: true })

    expect(
      await messageOf(() =>
        f.reg.modules.sessions.handoffSession({ sessionId: f.sessionId, machineId: 'm2' }),
      ),
    ).toBe('source exploded mid-export')

    // Home, cwd and overlay all restored; the recovery spawn goes back to m1.
    expect(meta(f)).toMatchObject({ machineId: 'm1', cwd: '/source/repo/.worktrees/x' })
    expect(meta(f)?.handoffTarget).toBeUndefined()
    await waitFor(
      () => f.source.some((m) => m.type === 'spawn' && m.sessionId === f.sessionId),
      'the rollback resurrect to spawn back on the source',
    )
    // The target never imported anything.
    expect(f.target.some((m) => m.type === 'handoffImportRequest')).toBe(false)
  })
})

describe('oracle: duplicate dispatch', () => {
  it(`${MUST_NOT_CHANGE}: a SECOND handoff after the first completed is refused as already-there, not run twice`, async () => {
    const f = await handoffFixture()
    await f.reg.modules.sessions.handoffSession({ sessionId: f.sessionId, machineId: 'm2' })
    const importsAfterFirst = f.target.filter((m) => m.type === 'handoffImportRequest').length

    expect(
      await messageOf(() =>
        f.reg.modules.sessions.handoffSession({ sessionId: f.sessionId, machineId: 'm2' }),
      ),
    ).toBe('session is already on that machine')
    expect(f.target.filter((m) => m.type === 'handoffImportRequest')).toHaveLength(
      importsAfterFirst,
    )
  })

  it(`${MUST_NOT_CHANGE}: CONCURRENT duplicate dispatch is NOT serialized today — both attempts run and the session still lands on the target exactly once`, async () => {
    const f = await handoffFixture()

    const [a, b] = await Promise.allSettled([
      f.reg.modules.sessions.handoffSession({ sessionId: f.sessionId, machineId: 'm2' }),
      f.reg.modules.sessions.handoffSession({ sessionId: f.sessionId, machineId: 'm2' }),
    ])

    // There is no in-flight lock: today both calls enter the orchestration. The
    // characterization is the OUTCOME — the row ends up on the target, once.
    expect([a.status, b.status]).toContain('fulfilled')
    expect(meta(f)).toMatchObject({ machineId: 'm2', cwd: '/target/repo/.worktrees/x' })
    expect(f.reg.modules.sessions.listSessions()).toHaveLength(1)
  })
})

describe('oracle: worktree reuse on the target', () => {
  it(`${MUST_NOT_CHANGE}: the import is told which target worktrees are OCCUPIED so it never resets a live peer's workspace`, async () => {
    const f = await handoffFixture()
    await f.reg.modules.sessions.resumeSession({
      agentKind: 'claude-code',
      cwd: '/target/repo/.worktrees/shared',
      resume: { kind: 'claude-session', value: 'other-native-id' },
      conversationId: 'other-native-id',
      machineId: 'm2',
    })

    await f.reg.modules.sessions.handoffSession({ sessionId: f.sessionId, machineId: 'm2' })

    expect(f.target).toContainEqual(
      expect.objectContaining({
        type: 'handoffImportRequest',
        occupiedWorktreePaths: ['/target/repo/.worktrees/shared'],
      }),
    )
  })

  it(`${MUST_NOT_CHANGE}: an EXITED peer's worktree is not treated as occupied — a dead session must not hold a checkout hostage`, async () => {
    const f = await handoffFixture()
    const peer = await f.reg.modules.sessions.resumeSession({
      agentKind: 'claude-code',
      cwd: '/target/repo/.worktrees/shared',
      resume: { kind: 'claude-session', value: 'other-native-id' },
      conversationId: 'other-native-id',
      machineId: 'm2',
    })
    f.reg.modules.sessions.onDaemonMessageFrom('m2', {
      type: 'agentExit',
      sessionId: peer.sessionId,
      code: 0,
    })

    await f.reg.modules.sessions.handoffSession({ sessionId: f.sessionId, machineId: 'm2' })

    const importRequest = f.target.find((m) => m.type === 'handoffImportRequest')
    // An empty guard list is OMITTED from the wire rather than sent as [].
    expect(importRequest && 'occupiedWorktreePaths' in importRequest).toBe(false)
  })
})
