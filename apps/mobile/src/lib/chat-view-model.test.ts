import { MobxPool } from '@podium/client-graph'
import { here } from '@podium/client-graph/lookup'
import { DraftStore } from '@podium/client-core/conversation'
import { chatActivity } from '@podium/client-core/values'
import { asSessionId } from '@podium/model'
import { autorun, runInAction } from 'mobx'
import { expect, it, vi } from 'vitest'
import { MobileConversation } from './mobile-conversation'
import { MobileChatViewModel } from './chat-view-model'

it('keeps each phone reader independent while sharing its session draft and stream', async () => {
  const sid = asSessionId('phone-view')
  const drafts = new DraftStore({ storage: { get: () => null, set() {} }, hub: {
    on: () => () => {}, sendDraftEdit() { return true }, connectionHealth: () => ({ status: 'ok', since: 0, rttMs: null }),
  } })
  const pool = new MobxPool({ selectedIssueId: null })
  pool.bindSessionDrafts(drafts)
  const row = { sessionId: sid, status: 'live', cwd: '/repo', title: 'Chat', agentState: { phase: 'idle' }, offer: { createdAt: '2026-10-10T10:00:00Z', message: 'Ready', actions: [] }, lastActiveAt: '2026-10-10T10:00:00Z' }
  pool.apply({ type: 'update', rows: [{ kind: 'session', id: sid, value: row as never }] })
  const service = new MobileConversation({ sessionId: sid, drafts,
    readSession: () => here(pool.model('session', sid)), headless: true,
    transcript: { source: { read: async () => ({ items: [], hasMore: false }), subscribe: () => () => {} } },
    sends: { createDeliveryId: () => 'send', deliver: async () => {} },
  })
  const first = new MobileChatViewModel(service, pool), second = new MobileChatViewModel(service, pool)
  const closeFirst = first.open(), closeSecond = second.open()
  const stops: (() => void)[] = []
  try {
    await service.start()
    first.setFollowing(false); first.setSearching(true); first.setBackendModel('picked', 'codex')
    first.find.setQuery('first reader'); first.find.setCursor(2)
    expect(second.following).toBe(true)
    expect(second.searching).toBe(false)
    expect(second.backendPick).toEqual({})
    expect(second.find.query).toBe('')
    expect(second.find.cursor).toBe(0)
    expect(first.activity).toEqual(chatActivity(row as never, false))
    await service.sends.sendOffer('continue', row.offer.createdAt)
    const { offer: _offer, ...answered } = row // The original phone answer on a plain fixture.
    expect(first.activity).toEqual(chatActivity(answered as never, true))
    expect(() => expect({ ...first.activity, label: 'wrong' }).toEqual(chatActivity(answered as never, true))).toThrow()
    first.setDraft('shared draft')
    expect(second.draft).toBe('shared draft')
    expect(here(pool.model('session', sid))?.messageDraft).toBe('shared draft')
    runInAction(() => { service.turnRunning = true; service.headless = { text: 'first token' } })
    const chrome = vi.fn(() => [first.session?.title, first.session?.status, first.turnRunning, first.overlayLabel, first.activity, first.composer])
    const message = vi.fn(() => first.liveItem?.text)
    stops.push(autorun(chrome), autorun(message))
    chrome.mockClear(); message.mockClear()
    runInAction(() => { service.headless = { text: 'first token and second token' } })
    expect(message).toHaveBeenCalledTimes(1)
    expect(chrome).not.toHaveBeenCalled()
    pool.apply({ type: 'update', rows: [{ kind: 'session', id: sid, value: { ...row, lastActiveAt: '2026-10-10T10:01:00Z', agentState: { ...row.agentState, workingMsTotal: 1000 } } as never }] })
    expect(chrome).not.toHaveBeenCalled()
  } finally {
    stops.forEach(stop => stop()); closeFirst(); closeSecond(); service.dispose(); pool.dispose(); drafts.dispose()
  }
})

it('writes a reply to the asker into its own draft and leaves the prompt draft alone (POD-2380)', async () => {
  const sid = asSessionId('phone-reply')
  const drafts = new DraftStore({ storage: { get: () => null, set() {} }, hub: {
    on: () => () => {}, sendDraftEdit() { return true }, connectionHealth: () => ({ status: 'ok', since: 0, rttMs: null }),
  } })
  const pool = new MobxPool({ selectedIssueId: null })
  pool.bindSessionDrafts(drafts)
  const row = { sessionId: sid, status: 'live', cwd: '/repo', title: 'Chat', agentState: { phase: 'idle' }, lastActiveAt: '2026-10-10T10:00:00Z' }
  pool.apply({ type: 'update', rows: [{ kind: 'session', id: sid, value: row as never }] })
  const service = new MobileConversation({ sessionId: sid, drafts,
    readSession: () => here(pool.model('session', sid)), headless: true,
    transcript: { source: { read: async () => ({ items: [], hasMore: false }), subscribe: () => () => {} } },
    sends: { createDeliveryId: () => 'send', deliver: async () => {} },
  })
  const replyApi = { show: vi.fn(async () => ({})), reply: vi.fn(async () => ({})) }
  const view = new MobileChatViewModel(service, pool, replyApi)
  const close = view.open()
  try {
    view.setDraft('prompt words')
    view.reply.start({ id: 'msg_q', from: 'issue:POD-1906' } as never)
    expect(view.draft).toBe('')
    view.setDraft('move it to the report')
    expect(view.reply.draft).toBe('move it to the report')
    expect(here(pool.model('session', sid))?.messageDraft).toBe('prompt words')
    view.reply.cancel()
    expect(view.draft).toBe('prompt words')
    view.reply.start({ id: 'msg_q', from: 'issue:POD-1906' } as never)
    close()
    // Leaving the chat closes the reply, so the next visit writes a prompt.
    expect(view.reply.active).toBe(false)
  } finally {
    service.dispose(); pool.dispose(); drafts.dispose()
  }
})
