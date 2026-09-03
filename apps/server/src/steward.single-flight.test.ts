import { asSessionId, type SessionMeta } from '@podium/model'
import { normalizeSettings } from '@podium/runtime'
import { describe, expect, it, vi } from 'vitest'
import { type IssueDeps, IssueService } from './modules/issues/service'
import { issueTestPlumbing } from './modules/issues/service/test-plumbing'
import { type StewardDeps, StewardService } from './steward'
import { SessionStore } from './store'

/**
 * THE CURSOR IS THE THING BEING FENCED (POD-3258). A poll reads one durable
 * cursor, handles the events past it, and only then advances it — deliberately,
 * so a delivery failure re-reads the same window. That makes an overlapping poll
 * a poll of the SAME window: both read the pre-advance cursor.
 *
 * The probe re-enters from inside `listEventsSince`, which is after the cursor
 * has been resolved and before anything has been delivered — the widest part of
 * the window, and where an awaited store read will park. `listEventsSince`
 * calls are therefore the count that matters.
 */
describe('StewardService.tick single-flight (POD-3258)', () => {
  function harness() {
    const store = new SessionStore(':memory:')
    store.events.setStewardState('cursor', '0')
    const sessions: SessionMeta[] = []
    const settings = normalizeSettings({
      steward: { enabled: true },
      gitWorkflow: { defaultParentBranch: '', mergeStyle: 'ff-only', autoRebaseBeforeMerge: true },
      sessionDefaults: { agent: 'claude-code' },
    })
    let clockMs = Date.parse('2026-07-02T00:00:00.000Z')
    const now = () => new Date(clockMs++).toISOString()
    const issueDeps: IssueDeps = {
      store,
      listSessions: () => sessions,
      getSettings: () => settings,
      spawnSession: vi.fn(() => ({ sessionId: asSessionId('s1'), machine: 'machine-under-test' })),
      repoOp: vi.fn(async () => ({ ok: true, output: '' })),
      ...issueTestPlumbing(),
      now,
    }
    const issues = IssueService.create(issueDeps)

    let listEventsSinceCalls = 0
    let onListEvents: () => void = () => {}
    const events = new Proxy(store.events, {
      get(target, prop, receiver) {
        if (prop === 'listEventsSince') {
          return (...args: unknown[]) => {
            listEventsSinceCalls += 1
            onListEvents()
            return (target.listEventsSince as (...a: unknown[]) => unknown)(...args)
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    })

    const deps: StewardDeps = {
      store: events,
      facts: store.notificationFacts,
      messages: store.messages,
      issues,
      listSessions: () => sessions,
      sendTextWhenReady: vi.fn(),
      notify: vi.fn(),
      getSettings: () => settings,
      now,
    }
    return {
      steward: new StewardService(deps),
      calls: () => listEventsSinceCalls,
      setOnListEvents: (fn: () => void) => {
        onListEvents = fn
      },
    }
  }

  it('skips a poll that lands on a poll already running', async () => {
    const h = harness()
    let inner: Promise<void> | undefined
    h.setOnListEvents(() => {
      if (inner) return
      inner = h.steward.tick()
    })

    await h.steward.tick()
    await inner

    expect(inner).toBeDefined()
    expect(h.calls()).toBe(1)
  })

  it('a later, non-overlapping poll runs normally', async () => {
    const h = harness()
    await h.steward.tick()
    await h.steward.tick()
    expect(h.calls()).toBe(2)
  })

  it('releases the fence when a poll throws', async () => {
    const h = harness()
    let first = true
    h.setOnListEvents(() => {
      if (!first) return
      first = false
      throw new Error('store is gone')
    })

    await expect(h.steward.tick()).rejects.toThrow('store is gone')
    await h.steward.tick()

    expect(h.calls()).toBe(2)
  })
})
