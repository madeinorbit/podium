/**
 * OPERATIONS ON A PARKED SESSION DO THE SAME WHETHER IT IS IN MEMORY OR NOT
 * (POD-6160 D2f).
 *
 * Each arm boots a registry with eviction ON, parks a set of sessions and runs
 * the same operations on them through the public seams (the lifecycle, the
 * session-state envelope, the daemon RPC, daemon frames). The RESIDENT arm
 * never sweeps, so every parked session stays in the map, which is how the
 * server ran before the map shrank. The EVICTED arm sweeps before every step,
 * so each operation finds its session out of memory and its lease restores it.
 * The answers and the final database records must be the same; the evicted
 * arm also checks that nothing parked stayed resident after a step.
 */
import { asSessionId, firstAdminMemberId, type SessionId } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionRegistry } from '../../relay'
import type { SessionStore } from '../../store'
import { RUNTIME_EVENT_LOG_KIND } from '../../store/events'
import { attachHostDaemon } from '../../test-support/host-daemon'
import { openTestStore } from '../../test-support/open-test-store'
import { durableView, isRunningStatus } from './records'

const registries: SessionRegistry[] = []
afterEach(async () => {
  for (const reg of registries.splice(0)) await reg.dispose()
})

const at = '2026-10-16T12:00:00.000Z'

async function plantTranscript(store: SessionStore, sessionId: SessionId) {
  await store.events.appendEvent({
    ts: at,
    kind: RUNTIME_EVENT_LOG_KIND,
    subject: sessionId,
    payload: {
      t: 'item',
      item: { kind: 'complete', item: { id: `item-${sessionId}`, role: 'assistant', text: 'parked words', ts: at } },
      at,
      provenance: 'live',
      observerGeneration: 1,
      turnEpoch: 1,
      cursor: { segmentId: 'segment', components: { seq: 1 } },
    },
  })
}

async function scenario(evict: boolean) {
  const store = await openTestStore(':memory:')
  await store.repos.addRepo('/r', store.hostMachineId)
  const reg = await SessionRegistry.create(store, undefined, {
    instanceId: 'default',
    sessionResidency: { evictParked: true, sweepIntervalMs: 0 },
  })
  registries.push(reg)
  await attachHostDaemon(reg)
  const sessions = reg.modules.sessions
  const machine = store.hostMachineId
  const admin = firstAdminMemberId()
  const issue = await reg.modules.issues.crud.create({ repoPath: '/r', title: 'T', startNow: false })

  const ids: SessionId[] = []
  for (let i = 0; i < 9; i++) {
    const cwd = `/r/w${i}`
    const { sessionId } = await sessions.createSession({ agentKind: 'claude-code', cwd })
    await reg.gateway.routeDaemonFrame(machine, {
      type: 'bind',
      sessionId,
      cmd: 'claude',
      cwd,
      agentKind: 'claude-code',
      geometry: { cols: 100, rows: 30 },
    } as never)
    await reg.gateway.routeDaemonFrame(machine, {
      type: 'sessionResumeRef',
      sessionId,
      resume: { kind: 'claude', value: `conv-${i}` },
    })
    ids.push(sessionId)
  }
  for (const id of ids.slice(0, 7)) await reg.gateway.routeDaemonFrame(machine, { type: 'agentExit', sessionId: id, code: 0 })
  for (const id of ids.slice(7)) expect((await sessions.hibernateSession({ sessionId: id })).ok).toBe(true)
  await plantTranscript(store, ids[0]!)
  await sessions.flushActivity()

  const answers: unknown[] = []
  const step = async (name: string, op: () => Promise<unknown>) => {
    if (evict) {
      await sessions.flushActivity()
      sessions.residency.sweep()
      for (const id of ids) {
        const resident = sessions.sessions.get(id)
        if (resident) expect({ name, id, why: sessions.residency.residentBecause(id) }).toMatchObject({ why: 'running' })
      }
    }
    answers.push([name, await op()])
  }
  const [s0, s1, s2, s3, s4, s5, s6, s7, s8] = ids as [SessionId, ...SessionId[]] as SessionId[]

  await step('rename', () => sessions.renameSession({ sessionId: s0!, name: 'Renamed' }))
  await step('agentName', () => sessions.setAgentName({ sessionId: s1!, name: 'Agent named' }))
  await step('archive', () => sessions.setArchived({ sessionId: s2!, archived: true }))
  await step('workState', () => sessions.setWorkState({ sessionId: s3!, workState: 'done' } as never))
  await step('issue', () => sessions.setSessionIssueId(s4!, issue.id))
  await step('read', () => sessions.markSessionRead(admin, s5!))
  await step('unread', () => sessions.markSessionUnread(admin, s5!))
  await step('snooze', () => sessions.setSnooze({ userId: admin, sessionId: s5!, until: '2099-01-01T00:00:00.000Z' }))
  await step('offer', () =>
    sessions.setOffer({ sessionId: s6!, message: 'next', actions: [{ label: 'Go', prompt: 'go' }] } as never),
  )
  await step('dismissOffer', async () => {
    const offer = (await sessions.records.read([s6!])).get(s6!)?.offer
    return await sessions.dismissOffer(s6!, offer!.createdAt)
  })
  await step('transcript', async () =>
    (await reg.modules.rpc.readTranscript({ sessionId: s0!, direction: 'before', limit: 10 }, { kind: 'user', id: admin }))
      .items.map((item) => item.text),
  )
  await step('resurrect', async () => {
    const result = await reg.modules.issueSessionLifecycle.resurrectSession({ sessionId: s7! })
    return { ok: result.ok }
  })
  await step('lateExit', () => reg.gateway.routeDaemonFrame(machine, { type: 'agentExit', sessionId: s8!, code: 3 }))
  await step('kill', () => sessions.killSession({ sessionId: s1! }))
  await sessions.flushActivity()

  // The durable outcome, with the ids and clocks of this arm named generically.
  const records = await sessions.records.read(ids)
  const names = new Map<string, string>(ids.map((id, i) => [id, `s${i}`]))
  names.set(issue.id, 'issue')
  names.set(machine, 'machine')
  const normalize = (value: unknown): unknown =>
    JSON.parse(
      JSON.stringify(value, (key, v) => {
        if (typeof v === 'string' && names.has(v)) return names.get(v)
        if (typeof v === 'string' && key === 'conversationPodiumId') return 'conversation'
        if (typeof v === 'string' && (/At$/.test(key) || key === 'since' || key === 'ts')) return 'time'
        if (typeof v === 'number' && /Ms(Total)?$/.test(key)) return 'ms'
        return v
      }),
    )
  return {
    answers: normalize(answers),
    records: ids.map((id) => [names.get(id), normalize(records.has(id) ? durableView(records.get(id)!) : null)]),
    running: ids.filter((id) => {
      const s = sessions.sessions.get(id)
      return s && isRunningStatus(s.status)
    }).map((id) => names.get(id)),
  }
}

describe('operations on a parked session (POD-6160 D2f)', () => {
  it('answer and write the same whether the session was in memory or restored from its row', async () => {
    const resident = await scenario(false)
    const evicted = await scenario(true)
    expect(evicted.answers).toEqual(resident.answers)
    expect(evicted.records).toEqual(resident.records)
    expect(evicted.running).toEqual(resident.running)
    // The scenario did what it says.
    const byName = new Map(resident.records as [string, { meta?: Record<string, unknown> } | null][])
    expect(byName.get('s0')?.meta).toMatchObject({ name: 'Renamed' })
    expect(byName.get('s1')).toBeNull()
    expect(byName.get('s2')?.meta).toMatchObject({ archived: true })
    expect(byName.get('s4')?.meta).toMatchObject({ issueId: 'issue' })
    expect(resident.answers).toContainEqual(['transcript', ['parked words']])
    expect(asSessionId('x')).toBe('x')
  }, 60_000)
})
