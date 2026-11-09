/**
 * Agent profiles against the real migrated schema (POD-6107): the six seeded
 * starters, the record writes (POD-6676) with the people-only rule and the
 * in-use delete guard, the .md export, and the launch's first-usable-candidate
 * pick. Import parses on the CLI now (`apps/cli/src/profile-cli.test.ts`).
 */
import { asSessionId, asUserId, type MachineId } from '@podium/model'
import type { SqlDatabase } from '@podium/runtime/sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { AgentProfilesRepository } from '../../store/agent-profiles'
import { createBunStoreExecutor } from '../../store/executor'
import { openMigratedTestDatabase } from '../../test-support/migrated-database'
import { fixtureWriteScope } from '@podium/sync/testing'
import {
  type AgentProfileCaller,
  AgentProfileService,
  type AgentProfileWriter,
} from './service'

const ADMIN = asUserId('user:admin')
const MEMBER = asUserId('user:member')
const person: AgentProfileCaller = { userId: ADMIN, actorSessionId: null }
const agent: AgentProfileCaller = { userId: ADMIN, actorSessionId: asSessionId('sess-1') }

let db: SqlDatabase
let runnable: Set<string>
let probes: string[]
let service: AgentProfileService

beforeEach(() => {
  db = openMigratedTestDatabase()
  const queries = createBunStoreExecutor({ database: db }).queries
  if (!queries) throw new Error('no synchronous query capability')
  runnable = new Set(['claude-code', 'codex'])
  probes = []
  service = new AgentProfileService({
    store: new AgentProfilesRepository(queries),
    now: () => '2026-10-14T12:00:00.000Z',
    listMachines: async () => [
      { id: 'm-flat', name: 'flatblock', hostname: 'flatblock', online: true } as never,
    ],
    requireRunnable: async ({ agentKind }) => {
      probes.push(agentKind)
      if (!runnable.has(agentKind)) throw new Error(`${agentKind} is not installed`)
    },
    roleOf: async (userId) => (userId === ADMIN ? 'admin' : 'member'),
  })
})

const insertIssue = (seq: number, profileId: string, stage = 'in_progress'): void => {
  db.prepare(
    `INSERT INTO issues (id, owner_user_id, created_by_actor, repo_path, seq, title, stage,
       default_agent, agent_profile_id, created_at, updated_at)
     VALUES (?, ?, ?, '/repo', ?, 't', ?, 'auto', ?, 't0', 't0')`,
  ).run(`iss_${seq}`, ADMIN, ADMIN, seq, stage, profileId)
}

describe('agent profiles', () => {
  it('ships the six starter roles', async () => {
    const names = (await service.list()).map((p) => p.name)
    expect(names).toEqual(['build', 'design', 'qa', 'research', 'review', 'security'])
    const review = await service.show('review')
    expect(review.candidates.map((c) => c.harness)).toEqual(['codex', 'claude-code'])
    expect(review.instructions).toContain('review task')
  })

  // The record writes (POD-6676) commit on the command's writer; here it runs
  // the write and keeps the change entries it was handed.
  const changes: unknown[] = []
  const writer: AgentProfileWriter = {
    commit: async (op) => {
      const result = await op.write(fixtureWriteScope())
      changes.push(...(await op.changes(result)))
      return { result }
    },
  }

  it('creates, renames and updates by id, resolving a machine name, with a change entry each', async () => {
    const created = await service.createRecord(person, writer, 'agp_docs', {
      name: 'docs',
      description: 'Writes docs',
      candidates: [{ harness: 'claude-code', model: 'auto', effort: 'low' }],
      machineId: 'flatblock',
    })
    expect(created).toMatchObject({ id: 'agp_docs', name: 'docs', machineId: 'm-flat' })
    expect((await service.show('docs')).machineName).toBe('flatblock')
    const updated = await service.editRecord(person, writer, 'agp_docs', {
      name: 'writing',
      machineId: null,
    })
    expect(updated).toMatchObject({
      id: 'agp_docs',
      name: 'writing',
      machineId: null,
      description: 'Writes docs',
    })
    expect(changes).toEqual([
      { entity: 'agentProfile', id: 'agp_docs', op: 'upsert', value: created },
      { entity: 'agentProfile', id: 'agp_docs', op: 'upsert', value: updated },
    ])
    await expect(
      service.createRecord(person, writer, 'agp_other', { name: 'writing' }),
    ).rejects.toThrow(/already exists/)
    await expect(
      service.editRecord(person, writer, 'agp_docs', { machineId: 'nowhere' }),
    ).rejects.toThrow(/no visible machine named 'nowhere'/)
  })

  it('refuses every edit from an agent session, and from a non-admin person', async () => {
    const build = await service.show('build')
    for (const edit of [
      () => service.createRecord(agent, writer, 'agp_x', { name: 'x' }),
      () => service.editRecord(agent, writer, build.id, { description: 'mine now' }),
      () => service.removeRecord(agent, writer, build.id),
    ]) {
      await expect(edit()).rejects.toThrow(/edited by people only/)
    }
    await expect(
      service.createRecord({ userId: MEMBER, actorSessionId: null }, writer, 'agp_x', {
        name: 'x',
      }),
    ).rejects.toThrow(/instance admin/)
    expect((await service.show('build')).description).not.toBe('mine now')
  })

  it('refuses to remove a profile an open issue uses, and allows it once the issue is closed', async () => {
    const build = await service.show('build')
    insertIssue(7, build.id)
    await expect(service.removeRecord(person, writer, build.id)).rejects.toThrow(
      /used by 1 open issue\(s\) \(#7\)/,
    )
    db.prepare(`UPDATE issues SET stage = 'done' WHERE seq = 7`).run()
    await service.removeRecord(person, writer, build.id)
    expect(await service.find('build')).toBeNull()
    expect(changes.at(-1)).toEqual({ entity: 'agentProfile', id: build.id, op: 'remove' })
  })

  it('exports the .md shape', async () => {
    const [exported] = await service.export('qa')
    expect(exported?.text).toContain('name: qa\n')
    expect(exported?.text).toContain('effort: medium')
  })

  describe('launch', () => {
    it('picks the first candidate that can run, probing only when there is a choice', async () => {
      const review = await service.show('review')
      runnable.delete('codex')
      const launch = await service.launch({ profileId: review.id, fields: {}, cwd: '/repo' })
      expect(launch).toMatchObject({
        profile: { id: review.id, name: 'review' },
        agentKind: 'claude-code',
        effort: 'high',
      })
      expect(launch.instructions).toContain('review task')
      expect(probes).toEqual(['codex', 'claude-code'])

      probes = []
      const pinned = await service.launch({
        profileId: review.id,
        fields: { agent: 'codex' },
        cwd: '/repo',
      })
      expect(pinned.agentKind).toBe('codex')
      expect(probes).toEqual([])
    })

    it('applies the fields on top and treats a stale id as no profile', async () => {
      const build = await service.show('build')
      const launch = await service.launch({
        profileId: build.id,
        fields: { model: 'opus', effort: 'max', machineId: 'm-issue' as MachineId },
        cwd: '/repo',
      })
      expect(launch).toMatchObject({
        agentKind: 'claude-code',
        model: 'opus',
        effort: 'max',
        machineId: 'm-issue',
      })
      const stale = await service.launch({
        profileId: 'agp_gone',
        fields: { agent: 'codex' },
        cwd: '/repo',
      })
      expect(stale).toMatchObject({
        profile: null,
        agentKind: 'codex',
        model: 'auto',
        instructions: '',
      })
    })
  })
})
