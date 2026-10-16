import { fileURLToPath } from 'node:url'
import { asIssueId, asSessionId, asUserId, firstAdminMemberId } from '@podium/model'
import type { SessionStore } from '../store'
import { RUNTIME_EVENT_LOG_KIND } from '../store/events'

/**
 * THE BENCHMARK CORPUS'S SESSIONS, SEEDED INTO A STORE (POD-6160). Shared by the
 * session-record comparison and the residency tests.
 */

export interface CorpusSession {
  id: string
  agentKind: string
  title: string
  cwd: string
  status: string
  archived: boolean
  createdAt: string
  lastActiveAt: string
  issueId: string | null
  headless: boolean
  resumeKind: string | null
  resumeValue: string | null
  stoppedAt: string | null
}

export async function corpusSessions(): Promise<{ sessions: CorpusSession[]; repos: string[] }> {
  const module = fileURLToPath(
    new URL('../../../../scripts/server-data-bench/corpus-export.ts', import.meta.url),
  )
  const { exportCorpus } = (await import(module)) as {
    exportCorpus(cell: string, seed: number): Promise<{ sessions: CorpusSession[]; repos: string[] }>
  }
  return await exportCorpus('h1a1', 4443)
}

const at = (minute: number) => `2026-09-01T00:${String(minute % 60).padStart(2, '0')}:00.000Z`

export async function plantSatellites(store: SessionStore, ids: readonly string[], resumes: Map<string, string>) {
  let offers = 0
  let drafts = 0
  let transcripts = 0
  let conversations = 0
  for (const [index, raw] of ids.entries()) {
    const id = asSessionId(raw)
    if (index % 5 === 0) {
      // Every other offer predates the row's last input, which the boot install
      // clears and a record reads as absent.
      await store.sessions.setOffer(id, {
        message: `offer ${index}`,
        actions: [{ label: 'Go', prompt: 'go' }],
        ...(index % 10 === 0 ? { artifacts: ['shot.png'] } : {}),
        createdAt: index % 10 === 0 ? '2026-08-01T00:00:00.000Z' : '2026-10-01T00:00:00.000Z',
      })
      offers += 1
    }
    if (index % 7 === 0) {
      await store.sessions.setDraft(id, `draft ${index}`)
      drafts += 1
    }
    // The causal envelope every stored runtime event carries (the boot replay
    // parses it; an event without it is skipped there).
    const event = (body: Record<string, unknown>) =>
      store.events.appendEvent({
        ts: at(index),
        kind: RUNTIME_EVENT_LOG_KIND,
        subject: id,
        payload: {
          ...body,
          at: at(index),
          provenance: 'live',
          observerGeneration: 1,
          turnEpoch: 1,
          cursor: { segmentId: 'segment', components: { seq: index } },
        },
      })
    const complete = (n: number) => ({
      t: 'item',
      item: { kind: 'complete', item: { id: `item-${index}-${n}`, role: 'assistant', text: 'hi', ts: at(index) } },
    })
    switch (index % 6) {
      case 1: // items, no reset
        await event(complete(1))
        transcripts += 1
        break
      case 2: // items, then a reset with none: nothing since the reset
        await event(complete(1))
        await event({ t: 'transcript-reset', items: [] })
        transcripts += 1
        break
      case 3: // a reset carrying items
        await event({
          t: 'transcript-reset',
          items: [{ id: `seed-${index}`, role: 'user', text: 'seed', ts: at(index) }],
        })
        transcripts += 1
        break
      case 4: // a reset with none, then items
        await event({ t: 'transcript-reset', items: [] })
        await event(complete(2))
        transcripts += 1
        break
      case 5: // runtime events that are not transcript items
        await event({ t: 'turn', ev: { ev: 'started', turnEpoch: 1, origin: 'human' } })
        break
    }
    const resume = resumes.get(raw)
    if (resume && index % 3 === 0) {
      await store.conversations.registry.ensure({
        machineId: store.hostMachineId,
        nativeId: resume,
        providerId: 'claude-code',
      })
      conversations += 1
    }
  }
  return { offers, drafts, transcripts, conversations }
}

/**
 * The benchmark corpus's sessions (POD-6146: cell h1a1, seed 4443) written to
 * `store` with every kind of satellite planted (offers, drafts, runtime
 * transcript events, conversation ids): what `records.parity.test.ts` and
 * `residency.test.ts` boot a registry over.
 */
export async function seedCorpusSessions(store: SessionStore) {
  const corpus = await corpusSessions()
  for (const repo of corpus.repos) await store.repos.addRepo(repo, store.hostMachineId)
  const resumes = new Map<string, string>()
  const admin = await firstAdminMemberId(store)
  await store.transact(async () => {
    for (const [index, s] of corpus.sessions.entries()) {
      if (s.resumeValue) resumes.set(s.id, s.resumeValue)
      await store.sessions.upsertSession({
        id: asSessionId(s.id),
        ownerUserId: index % 6 === 0 ? asUserId('user:other') : admin,
        agentKind: s.agentKind,
        cwd: s.cwd,
        title: s.title,
        name: index % 4 === 0 ? `named ${index}` : null,
        ...(index % 4 === 0 ? { nameSource: index % 8 === 0 ? 'user' : 'agent' } : {}),
        originKind: s.resumeValue ? 'resume' : 'spawn',
        conversationId: s.resumeValue,
        resumeKind: s.resumeKind,
        resumeValue: s.resumeValue,
        status: s.status as never,
        exitCode: s.status === 'exited' ? index % 3 : null,
        durableLabel: `podium-${s.id}`,
        createdAt: s.createdAt,
        lastActiveAt: s.lastActiveAt,
        lastOutputAt: null,
        lastInputAt: index % 10 === 0 ? '2026-09-01T00:00:00.000Z' : null,
        lastResumedAt: null,
        archived: s.archived,
        workState: index % 9 === 0 ? 'done' : null,
        machineId: store.hostMachineId,
        headless: s.headless,
        issueId: s.issueId === null ? null : asIssueId(s.issueId),
        stoppedAt: s.stoppedAt,
        ...(s.stoppedAt ? { stopReason: 'self' as const } : {}),
        ...(index % 11 === 0 ? { workingMsTotal: index * 1000 } : {}),
        ...(index % 13 === 0 ? { conversationBinding: 'never' as const } : {}),
      } as never)
    }
  })
  const planted = await plantSatellites(
    store,
    corpus.sessions.map((s) => s.id),
    resumes,
  )
  return { corpus, planted }
}
