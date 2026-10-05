// @vitest-environment happy-dom
import { asSessionId } from '@podium/model'
import { autorun } from 'mobx'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SocketHub } from '../socket-transport/socket-hub'
import { DraftStore, DRAFTS_UI_KEY } from './draft-store'

const sid = asSessionId('s1'),
  other = asSessionId('s2')
function fixture(storage = new Map<string, string>()) {
  const send = vi.fn(),
    onChange = vi.fn()
  const handlers = new Map<string, Set<(...args: any[]) => void>>()
  const hub = {
    on(kind: string, listener: (...args: any[]) => void) {
      const listeners = handlers.get(kind) ?? new Set()
      handlers.set(kind, listeners)
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    sendDraftEdit: send,
    connectionHealth: () => ({ status: 'down', rttMs: null, since: 0 }),
  } as Pick<SocketHub, 'on' | 'sendDraftEdit' | 'connectionHealth'>
  const drafts = new DraftStore({
    storage: {
      get: (key) => storage.get(key) ?? null,
      set: (key, value) => {
        if (value === null) storage.delete(key)
        else storage.set(key, value)
      },
    },
    hub,
    onChange,
  })
  const emit = (kind: string, ...args: unknown[]) => {
    for (const listener of handlers.get(kind) ?? []) listener(...args)
  }
  return { drafts, send, onChange, storage, hub, emit }
}

afterEach(() => vi.useRealTimers())

describe('DraftStore durability', () => {
  it('paints text immediately, coalesces wire at 250ms and persists at 500ms', () => {
    vi.useFakeTimers()
    const f = fixture()
    f.drafts.set(sid, 'h')
    f.drafts.set(sid, 'hi')
    expect(f.drafts.get(sid)).toBe('hi')
    expect(f.send).not.toHaveBeenCalled()
    expect(f.storage.size).toBe(0)
    vi.advanceTimersByTime(250)
    expect(f.send).toHaveBeenCalledExactlyOnceWith(sid, 0, 'hi')
    vi.advanceTimersByTime(250)
    expect(JSON.parse(f.storage.get(DRAFTS_UI_KEY)!)[sid].text).toBe('hi')
    f.drafts.dispose()
  })

  it('another composer draft never invalidates this addressed text', () => {
    const f = fixture(),
      notify = vi.fn()
    const stop = autorun(() => {
      f.drafts.get(sid)
      notify()
    })
    notify.mockClear()
    f.drafts.set(other, 'elsewhere')
    expect(notify).not.toHaveBeenCalled()
    f.drafts.set(sid, 'here')
    expect(notify).toHaveBeenCalledTimes(1)
    stop()
    f.drafts.dispose()
  })

  it('flushes the final unsent keystroke on sign-out and restores it dirty after reload', () => {
    vi.useFakeTimers()
    const f = fixture()
    f.drafts.set(sid, 'last keystroke')
    f.drafts.dispose()
    expect(vi.getTimerCount()).toBe(0)
    const reloaded = fixture(f.storage)
    expect(reloaded.drafts.get(sid)).toBe('last keystroke')
    reloaded.drafts.flush()
    expect(reloaded.send).toHaveBeenCalledWith(sid, 0, 'last keystroke')
    f.drafts.set(sid, 'late callback')
    expect(f.drafts.get(sid)).toBe('last keystroke')
    reloaded.drafts.dispose()
  })

  it('keeps local dirty text while adopting the remote revision, including a rollback', () => {
    vi.useFakeTimers()
    const f = fixture()
    f.drafts.adoptRemote(sid, { text: 'remote', rev: 10 })
    f.drafts.set(sid, 'local')
    f.drafts.adoptRemote(sid, { text: 'stale', rev: 3 })
    expect(f.drafts.get(sid)).toBe('local')
    f.drafts.flush()
    expect(f.send).toHaveBeenLastCalledWith(sid, 3, 'local')
    f.drafts.adoptRemote(sid, { text: 'local', rev: 4 })
    f.send.mockClear()
    f.drafts.flush()
    expect(f.send).not.toHaveBeenCalled()
    f.drafts.adoptRemote(sid, { text: 'phone', rev: 5 })
    expect(f.drafts.get(sid)).toBe('phone')
    f.drafts.dispose()
  })

  it('sends a clear immediately and persists it before the next reload', () => {
    vi.useFakeTimers()
    const f = fixture()
    f.drafts.set(sid, 'sent')
    f.drafts.set(sid, '')
    expect(f.send).toHaveBeenLastCalledWith(sid, 0, '')
    f.drafts.dispose()
    const reloaded = fixture(f.storage)
    expect(reloaded.drafts.get(sid)).toBe('')
    reloaded.drafts.dispose()
  })

  it('reconnect flushes dirty text immediately and clean remote documents do not echo', () => {
    vi.useFakeTimers()
    const f = fixture()
    f.drafts.start()
    f.drafts.set(sid, 'offline keystroke')
    f.emit('sessionDraft', other, 'other device', { rev: 2 })
    expect(f.drafts.get(other)).toBe('other device')
    f.emit('connectionHealth', { status: 'ok', rttMs: null, since: 0 })
    expect(f.send).toHaveBeenCalledExactlyOnceWith(sid, 0, 'offline keystroke')
    f.emit('sessionDraft', sid, 'offline keystroke', { rev: 1 })
    vi.advanceTimersByTime(500)
    expect(f.send).toHaveBeenCalledTimes(1)
    f.drafts.dispose()
  })

  it('pagehide flushes the final keystroke and restartable cleanup restores its listener', () => {
    vi.useFakeTimers()
    const f = fixture()
    f.drafts.start()
    f.drafts.start()
    f.drafts.set(sid, 'before navigation')
    window.dispatchEvent(new Event('pagehide'))
    expect(JSON.parse(f.storage.get(DRAFTS_UI_KEY)!)[sid].text).toBe('before navigation')
    f.drafts.stop()
    f.drafts.start()
    f.drafts.set(sid, 'after remount')
    window.dispatchEvent(new Event('pagehide'))
    expect(JSON.parse(f.storage.get(DRAFTS_UI_KEY)!)[sid].text).toBe('after remount')
    f.drafts.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ignores a corrupt saved blob and keeps unaffected entries in a partly corrupt ledger', () => {
    const bad = fixture(new Map([[DRAFTS_UI_KEY, 'broken']]))
    expect(bad.drafts.get(sid)).toBe('')
    bad.drafts.dispose()
    const f = fixture(
      new Map([
        [
          DRAFTS_UI_KEY,
          JSON.stringify({
            [sid]: { text: 'safe', serverRev: 2, editedAt: 5 },
            [other]: { text: 1 },
          }),
        ],
      ]),
    )
    expect(f.drafts.get(sid)).toBe('safe')
    expect(f.drafts.get(other)).toBe('')
    f.drafts.dispose()
  })

  it('reports failed storage without losing on-screen text, and strict reload persistence rejects', () => {
    const error = new Error('storage unavailable'),
      onStorageError = vi.fn()
    const drafts = new DraftStore({
      storage: {
        get: () => null,
        set: () => {
          throw error
        },
      },
      hub: fixture().hub,
      onStorageError,
    })
    drafts.set(sid, 'on screen')
    expect(() => drafts.persist(true)).toThrow(error)
    expect(drafts.get(sid)).toBe('on screen')
    expect(onStorageError).toHaveBeenCalledWith(error)
    drafts.dispose()
  })
})
