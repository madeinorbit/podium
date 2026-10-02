import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asMachineId, asRepoId, firstAdminMemberId } from '@podium/model'
import { openDatabase } from '@podium/runtime/sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HandoffPlacement } from './modules/sessions/handoff/placement'
import type { HandoffInput } from './modules/sessions/handoff/ports'
import { HandoffPreflight, type HandoffPreflightPorts } from './modules/sessions/handoff/preflight'
import { Session } from './modules/sessions/session'
import { SessionRegistry } from './relay'
import { attachHostDaemon } from './test-support/host-daemon'
import { openTestStore } from './test-support/open-test-store'

const registries: SessionRegistry[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const registry of registries.splice(0)) await registry.dispose()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'session-refs-'))
  dirs.push(dir)
  const path = join(dir, 'fixture.db')
  const store = await openTestStore(path)
  const raw = openDatabase(path)
  try {
    raw.exec('DROP INDEX idx_issues_repo_id_seq')
  } finally {
    raw.close()
  }
  const registry = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
  registries.push(registry)
  await attachHostDaemon(registry, () => {}, { repos: ['/heal/a', '/heal/b'] })
  const sessions = registry.modules.sessions
  const a = await registry.issues.create({ repoPath: '/heal/a', title: 'A', startNow: false })
  const b = await registry.issues.create({ repoPath: '/heal/b', title: 'B', startNow: false })
  const repoId = asRepoId('repo:common')
  for (const issue of [a, b]) {
    const row = await store.issues.getIssue(issue.id)
    await store.issues.upsertIssue({ ...row!, seq: 1, repoId })
  }
  const { sessionId } = await sessions.createSession({ agentKind: 'shell', cwd: '/unmapped' })
  await sessions.setSessionIssueId(sessionId, b.id)
  return { registry, store, sessions, sessionId, repoId }
}

describe('S1 rare reference repairs', () => {
  it('seq-collision heal publishes the affected birth session in the same commit', async () => {
    const f = await fixture()
    const cursor = await f.registry.changeLedger.cursor()
    expect(await f.store.issues.renumberCollidingIssueSeqs()).toBe(1)
    const changes = await f.registry.changeLedger.changesSince(cursor)
    expect(
      changes?.filter((change) => change.entity === 'session').map((change) => change.id),
    ).toEqual([f.sessionId])
    const session = (await f.registry.changeLedger.authority.snapshot('session')) as {
      sessionId: string
      refSeq?: number
      refRepoId?: string
    }[]
    expect(session.find((row) => row.sessionId === f.sessionId)).toMatchObject({
      refRepoId: f.repoId,
      refSeq: 2,
    })
  })

  it('repo-id repair and session ref publication roll back with their enclosing commit', async () => {
    const f = await fixture()
    const before = await f.registry.changeLedger.authority.snapshot('session')
    const cursor = await f.registry.changeLedger.cursor()
    await expect(
      f.store.transact(async () => {
        await f.store.issues.assignRepoIdToIssuesUnder(asRepoId('repo:new'), '/heal/b')
        throw new Error('rollback ref repair')
      }),
    ).rejects.toThrow('rollback ref repair')
    expect(await f.registry.changeLedger.authority.snapshot('session')).toEqual(before)
    expect(await f.registry.changeLedger.cursor()).toBe(cursor)
    expect((await f.sessions.sessionById(f.sessionId))?.refRepoId).toBe(f.repoId)
  })

  it('handoff target id accompanies the legacy label and clears on failed preflight', async () => {
    const f = await fixture()
    const current = new Session({
      sessionId: f.sessionId,
      ownerUserId: await firstAdminMemberId(f.store),
      durableLabel: 'fixture',
      agentKind: 'shell',
      cwd: '/p',
      title: 'Handoff',
      origin: { kind: 'spawn' },
      createdAt: '2026-01-01T00:00:00.000Z',
      geometry: { cols: 80, rows: 24 },
      machineId: f.store.hostMachineId,
      toDaemon: vi.fn(),
    })
    const target = asMachineId('machine:target')
    const preflight = new HandoffPreflight({
      mutateSessionView: (_id: Session['sessionId'], mutate: (session: Session) => void) =>
        mutate(current),
      broadcastSessions: () => {},
      ensureTargetRepo: async () => {
        expect(current.handoffTargetMachineId).toBe(target)
        expect(current.toMeta()).toMatchObject({
          handoffTargetMachineId: target,
        })
        throw new Error('clone failed')
      },
      rpc: {},
    } as unknown as HandoffPreflightPorts)
    await expect(
      preflight.prepare(
        {
          session: current,
          sourceRepo: { path: '/p' },
          targetMachine: { id: target, name: 'Target' },
        } as HandoffPlacement,
        { sessionId: f.sessionId, machineId: target } as HandoffInput,
        () => {},
      ),
    ).rejects.toThrow('clone failed')
    expect(current.handoffTargetMachineId).toBeUndefined()
    expect(current.handoffTargetMachineId).toBeUndefined()
  })
})
