import { type ConversationOptions, DraftStore } from '@podium/client-core/conversation'
import { MobxPool } from '@podium/client-graph'
import { here } from '@podium/client-graph/lookup'
import { asSessionId, type MessageRecordWire } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import { MobileChatViewModel } from './chat-view-model'
import { MobileConversation } from './mobile-conversation'

describe('phone wake outcome', () => {
  it('keeps a new send waking and ends it on exit, failed wake, and reload', async () => {
    vi.stubGlobal('Worker', undefined)
    const sessionId = asSessionId('wake-session')
    const pool = new MobxPool({ selectedIssueId: null })
    const drafts = new DraftStore({
      storage: { get: () => null, set() {} },
      hub: {
        on: () => () => {},
        sendDraftEdit: () => true,
        connectionHealth: () => ({ status: 'ok', since: 0, rttMs: null }),
      },
    })
    pool.bindSessionDrafts(drafts)
    const base = {
      sessionId,
      title: 'Wake',
      cwd: '/repo',
      agentKind: 'claude-code',
      resumable: true,
      queuedMessageCount: 1,
      lastActiveAt: '2026-11-13T06:00:00Z',
    }
    const move = (status: string, stoppedAt?: string) =>
      pool.apply({
        type: 'update',
        rows: [
          {
            kind: 'session',
            id: sessionId,
            value: {
              ...base,
              status,
              stoppedAt,
              ...(status === 'exited' ? { exitCode: 1 } : {}),
            } as never,
          },
        ],
      })
    move('exited', '2026-11-13T06:00:00Z')
    let record: MessageRecordWire = {
      id: 'wake-message',
      sessionId,
      senderUserId: 'user',
      body: 'Continue',
      createdAt: '2026-11-13T06:00:10Z',
      status: 'stored',
    }
    const listeners = new Set<() => void>()
    const options: ConversationOptions = {
      sessionId,
      drafts,
      readSession: () => here(pool.model('session', sessionId)),
      transcript: {
        source: { read: async () => ({ items: [], hasMore: false }), subscribe: () => () => {} },
      },
      sends: {
        createDeliveryId: () => 'local',
        deliver: async () => ({ state: 'queued' }),
        records: {
          getSnapshot: () => [record],
          subscribe: (listener) => {
            listeners.add(listener)
            return () => listeners.delete(listener)
          },
        },
      },
    }
    const service = new MobileConversation(options)
    const view = new MobileChatViewModel(service, pool)
    await service.start()
    try {
      expect(view.activity?.label).toBe('Waking the agent…')
      expect(view.composer.placeholder).toContain('Waking the agent')
      move('starting')
      expect(view.activity?.label).toBe('Waking the agent…')
      move('exited', '2026-11-13T06:00:11Z')
      expect(view.activity).toBeNull()
      expect(view.composer.placeholder).toBe('Message the agent to resume it…')
      // A second send is a new wake even while the old exit is still synced.
      record = { ...record, createdAt: '2026-11-13T06:00:12Z' }
      for (const listener of listeners) listener()
      expect(view.activity?.label).toBe('Waking the agent…')
      record = { ...record, status: 'failed', reason: 'wake failed' }
      for (const listener of listeners) listener()
      expect(view.activity).toBeNull()
      expect(view.composer.placeholder).toBe('Message the agent to resume it…')
      // A fresh reader cannot reconstruct waking from the leftover queue.
      move('hibernated')
      expect(view.activity).toBeNull()
      expect(view.composer.placeholder).toBe('Message the agent to resume it…')
      const reopened = new MobileChatViewModel(service, pool)
      expect(reopened.activity).toBeNull()
      expect(reopened.composer.placeholder).toBe('Message the agent to resume it…')
    } finally {
      service.dispose()
      pool.dispose()
      drafts.dispose()
      vi.unstubAllGlobals()
    }
  })
})
