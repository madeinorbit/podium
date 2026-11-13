import { type ConversationOptions, DraftStore } from '@podium/client-core/conversation'
import type { ClientRuntime } from '@podium/client-core/engine'
import { MobxPool } from '@podium/client-graph'
import { here } from '@podium/client-graph/lookup'
import { asSessionId, type MessageRecordWire } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import { MobileChatViewModel } from '../../../../mobile/src/lib/chat-view-model'
import { MobileConversation } from '../../../../mobile/src/lib/mobile-conversation'
import type { Trpc } from '../../app/trpc'
import { ChatViewModel } from './chat-view-model'
import { WebConversation } from './use-conversation'

describe.each(['desktop', 'phone'] as const)('%s wake outcome', (client) => {
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
    const service =
      client === 'phone'
        ? new MobileConversation(options)
        : new WebConversation(options, pool, { access: { trpc: {} } } as ClientRuntime<Trpc>, {})
    const view =
      service instanceof MobileConversation
        ? new MobileChatViewModel(service, pool)
        : new ChatViewModel(service, false, undefined, () => {})
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
      const reopened =
        service instanceof MobileConversation
          ? new MobileChatViewModel(service, pool)
          : new ChatViewModel(service, false, undefined, () => {})
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
