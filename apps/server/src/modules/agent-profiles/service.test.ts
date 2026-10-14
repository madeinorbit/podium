/**
 * Agent profiles against the real migrated schema (POD-6107): the six seeded
 * starters, the people-only edit rule, the in-use delete guard, the .md
 * round trip, and the launch's first-usable-candidate pick.
 */
import { asSessionId, asUserId, type MachineId } from '@podium/model'
import type { SqlDatabase } from '@podium/runtime/sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { AgentProfilesRepository } from '../../store/agent-profiles'
import { createBunStoreExecutor } from '../../store/executor'
import { openMigratedTestDatabase } from '../../test-support/migrated-database'
import { type AgentProfileCaller, AgentProfileRefusal, AgentProfileService } from './service'

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

  it('creates, renames and updates by name, resolving a machine name', async () => {
    const created = await service.create(person, {
      name: 'Docs',
      description: 'Writes docs',
      candidates: [{ harness: 'claude-code', model: 'auto', effort: 'low' }],
      machine: 'flatblock',
    })
    expect(created).toMatchObject({ name: 'docs', machineId: 'm-flat', machineName: 'flatblock' })
    const updated = await service.update(person, { ref: 'docs', name: 'writing', machine: null })
    expect(updated).toMatchObject({
      id: created.id,
      name: 'writing',
      machineId: null,
      description: 'Writes docs',
    })
    await expect(service.create(person, { name: 'writing' })).rejects.toThrow(/already exists/)
    await expect(service.update(person, { ref: 'writing', machine: 'nowhere' })).rejects.toThrow(
      /no visible machine named 'nowhere'/,
    )
  })

  it('refuses every edit from an agent session, and from a non-admin person', async () => {
    for (const edit of [
      () => service.create(agent, { name: 'x' }),
      () => service.update(agent, { ref: 'build', description: 'mine now' }),
      () => service.delete(agent, { ref: 'build' }),
      () => service.import(agent, { files: [{ text: '---\nname: x\n---\n' }] }),
    ]) {
      await expect(edit()).rejects.toThrow(/edited by people only/)
    }
    await expect(
      service.create({ userId: MEMBER, actorSessionId: null }, { name: 'x' }),
    ).rejects.toThrow(/instance admin/)
    expect((await service.show('build')).description).not.toBe('mine now')
  })

  it('refuses to delete a profile an open issue uses, and allows it once the issue is closed', async () => {
    const build = await service.show('build')
    insertIssue(7, build.id)
    await expect(service.delete(person, { ref: 'build' })).rejects.toThrow(
      /used by 1 open issue\(s\) \(#7\)/,
    )
    db.prepare(`UPDATE issues SET stage = 'done' WHERE seq = 7`).run()
    await expect(service.delete(person, { ref: 'build' })).resolves.toMatchObject({ name: 'build' })
    expect(await service.find('build')).toBeNull()
  })

  it('round-trips through the .md shape, creating or replacing by name', async () => {
    const [exported] = await service.export('qa')
    expect(exported?.text).toContain('name: qa\n')
    const edited = exported?.text.replace('effort: medium', 'effort: high') ?? ''
    const results = await service.import(person, {
      files: [
        { name: 'qa', text: edited },
        {
          name: 'triage',
          text: '---\ndescription: Sorts new issues\nmodel: auto\n---\nSort them.',
        },
      ],
    })
    expect(results).toEqual([
      { name: 'qa', action: 'updated' },
      { name: 'triage', action: 'created' },
    ])
    expect((await service.show('qa')).candidates[0]?.effort).toBe('high')
    expect(await service.show('triage')).toMatchObject({
      candidates: [{ harness: 'claude-code', model: 'auto', effort: 'auto' }],
      instructions: 'Sort them.',
    })
  })

  it('imports nothing when one file is bad', async () => {
    await expect(
      service.import(person, {
        files: [
          { name: 'ok', text: '---\nname: ok\n---\n' },
          { name: 'bad', text: 'no frontmatter' },
        ],
      }),
    ).rejects.toBeInstanceOf(AgentProfileRefusal)
    expect(await service.find('ok')).toBeNull()
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
