import { asSessionId, type SessionMeta, type TranscriptItem } from '@podium/model'
import { ConversationService, DraftStore } from '@podium/client-core/conversation'
import { Conversation as Before } from '../../client-core/src/conversation/service.before.test.fixture'
import { autorun, observable, runInAction } from 'mobx'
import { afterEach, expect, it, vi } from 'vitest'
import { MobxPool } from './pool'
import { here } from './lookup'

const sid = asSessionId('chat-service')
const stops: (() => void)[] = []
afterEach(() => { for (const stop of stops.splice(0).reverse()) stop() })
const item = (id: string, text: string): TranscriptItem => ({ id, cursor: id, role: 'assistant', text })

function fixture() {
  const drafts = new DraftStore({ storage: { get: () => null, set() {} }, hub: {
    on: () => () => {}, sendDraftEdit() {}, connectionHealth: () => ({ status: 'ok', since: 0, rttMs: null }),
  } })
  let row = { sessionId: sid, title: 'Chat title', cwd: '/repo', status: 'live',
    lastActiveAt: '2026-10-10T10:00:00Z', agentKind: 'codex',
    agentState: { phase: 'working', since: '2026-10-10T10:00:00Z' },
  } as SessionMeta
  const previous = observable.box(row, { deep: false })
  const pool = new MobxPool({ selectedIssueId: null })
  pool.bindSessionDrafts(drafts)
  const publish = (patch: Partial<SessionMeta>) => {
    row = { ...row, ...patch }
    runInAction(() => {
      previous.set(row)
      pool.apply({ type: 'update', rows: [{ kind: 'session', id: sid, value: row as never }] })
    })
  }
  publish({})
  const session = here(pool.model('session', sid))!
  const options = { sessionId: sid, drafts,
    transcript: { source: { read: async () => ({ items: [item('a', 'settled'), item('b', 'first token')], hasMore: false }), subscribe: () => () => {} } },
    sends: { createDeliveryId: () => 'send', deliver: async () => ({ state: 'sent' as const }) },
  }
  const before = new Before({ ...options, readSession: () => previous.get() })
  const after = new ConversationService({ ...options, readSession: () => session,
    drafts: { get: id => pool.sessionObject(id).messageDraft, set: (id, text) => pool.sessionObject(id).setMessageDraft(text) },
  })
  stops.push(() => { before.dispose(); after.dispose(); pool.dispose(); drafts.dispose() })
  return { before, after, session, previous, drafts, pool, publish }
}

it('matches the previous answers for every moved session fact and synced message draft', async () => {
  const f = fixture()
  await Promise.all([f.before.start(), f.after.start()])
  const oldFacts = () => ({ title: f.previous.get().title, status: f.before.status,
    phase: f.before.context.agentPhase, since: f.before.context.agentSince,
    error: f.before.context.agentError, offer: f.before.sends.offer, draft: f.before.draft,
    canInterrupt: f.before.context.canInterrupt,
  })
  const newFacts = () => ({ title: f.session.title, status: f.session.status,
    phase: f.session.agentPhase, since: f.session.agentSince,
    error: f.session.agentError, offer: f.after.sends.offer, draft: f.session.messageDraft,
    canInterrupt: f.after.canInterrupt,
  })
  const parity = () => {
    expect(newFacts()).toEqual(oldFacts())
    // Each comparison rejects a deliberately wrong new answer on these same fixtures.
    for (const key of Object.keys(newFacts())) {
      expect(() => expect({ ...newFacts(), [key]: 'wrong answer' }).toEqual(oldFacts())).toThrow()
    }
  }
  parity()
  f.session.setMessageDraft('typed on the web'); parity()
  f.drafts.adoptRemote(sid, { text: 'typed on the phone', rev: 2 }); parity()
  f.publish({ title: 'Renamed', status: 'hibernated', agentState: {
    phase: 'errored', since: '2026-10-10T10:01:00Z', error: { class: 'provider', retryable: false, detail: 'refused' },
  } as never, offer: { createdAt: '2026-10-10T10:01:00Z', message: 'Ready', actions: [] } as never })
  parity()
  await Promise.all([f.before.sends.submit({ text: 'next prompt' }), f.after.sends.submit({ text: 'next prompt' })])
  parity()
  expect(f.after.sends.bubbles).toEqual(f.before.sends.bubbles)
  f.publish({ offer: null, agentState: { phase: 'idle', since: '2026-10-10T10:02:00Z' } as never })
  parity()
})

it('does not redraw chat chrome for an unrelated session field or a streamed token', async () => {
  const f = fixture()
  await f.after.start()
  const chrome = vi.fn(() => [f.session.title, f.session.status, f.session.agentPhase,
    f.session.agentSince, f.session.agentError, f.after.sends.offer, f.after.canInterrupt])
  const first = vi.fn(() => f.after.transcript.byId.get('a')?.text)
  const streaming = vi.fn(() => f.after.transcript.byId.get('b')?.text)
  const order = vi.fn(() => f.after.transcript.ids.slice())
  stops.push(autorun(chrome), autorun(first), autorun(streaming), autorun(order))
  for (const read of [chrome, first, streaming, order]) read.mockClear()
  f.publish({ lastActiveAt: '2026-10-10T10:01:00Z', contextUsagePercent: 30 })
  expect(chrome).not.toHaveBeenCalled()
  f.after.transcript.merge([item('b', 'first token and second token')])
  expect(streaming).toHaveBeenCalledTimes(1)
  expect(first).not.toHaveBeenCalled()
  expect(order).not.toHaveBeenCalled()
  expect(chrome).not.toHaveBeenCalled()
  f.publish({ title: 'Visible title change' })
  expect(chrome).toHaveBeenCalledTimes(1)
})
