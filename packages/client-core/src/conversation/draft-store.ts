import type { SessionId } from '@podium/model'
import { action, actionBound, makeObservable, observable, observableShallow } from 'mobx'
import { createLogger } from '@podium/logger'
import { createDraftLedger, type DraftLedgerSnapshot } from '../drafts/draft-ledger'
import type { SocketHub } from '../socket-transport/socket-hub'

export const DRAFT_SEND_DEBOUNCE_MS = 250
export const DRAFT_PERSIST_DEBOUNCE_MS = 500
export const DRAFT_KEEP_LIMIT = 50
export const DRAFTS_UI_KEY = 'podium.drafts.v1'
const log = createLogger('client-core:drafts')

export interface DraftStoreOptions {
  storage: { get(key: string): string | null; set(key: string, value: string | null): void }
  hub: Pick<SocketHub, 'on' | 'sendDraftEdit' | 'connectionHealth'>
  sendDebounceMs?: number
  persistDebounceMs?: number
  /** Temporary bridge for readers that have not moved to MobX yet. */
  onChange?: (sessionId: SessionId, text: string) => void
  onStorageError?: (error: unknown) => void
  pagehide?: { subscribe(flush: () => void): () => void }
}

/** One user's composer documents. The existing ledger remains the sole arbiter. */
export class DraftStore {
  readonly values = observable.map<SessionId, string>(undefined, { deep: false })
  private readonly ledger = createDraftLedger()
  private readonly sendTimers = new Map<SessionId, ReturnType<typeof setTimeout>>()
  private persistTimer: ReturnType<typeof setTimeout> | null = null
  private stops: (() => void)[] = []
  private started = false
  private disposed = false

  constructor(private readonly options: DraftStoreOptions) {
    makeObservable(this, {
      values: observableShallow,
      set: actionBound,
      adoptRemote: actionBound,
    })
    // Hydrate synchronously: the very first composer read sees its durable text.
    try {
      const stored = options.storage.get(DRAFTS_UI_KEY)
      if (stored) this.ledger.restore(JSON.parse(stored) as DraftLedgerSnapshot)
    } catch {
      /* An unreadable device blob is a cold start. */
    }
    const snapshot = this.ledger.snapshot()
    action(() => {
      for (const [id, draft] of Object.entries(snapshot))
        this.values.set(id as SessionId, draft.text)
    })()
  }

  get(sessionId: SessionId): string {
    return this.values.get(sessionId) ?? ''
  }

  set(sessionId: SessionId, text: string): void {
    if (this.disposed) return
    this.ledger.localEdit(sessionId, text, Date.now())
    if (this.get(sessionId) !== text || !this.values.has(sessionId)) {
      this.values.set(sessionId, text)
      this.options.onChange?.(sessionId, text)
    }
    this.scheduleSend(sessionId, text === '')
    this.schedulePersist()
  }

  adoptRemote(sessionId: SessionId, incoming: { text: string; rev?: number }): void {
    if (this.disposed) return
    const previous = this.ledger.get(sessionId)
    const outcome = this.ledger.adoptRemote(sessionId, incoming)
    if (outcome.acceptText) {
      this.values.set(sessionId, incoming.text)
      this.options.onChange?.(sessionId, incoming.text)
    }
    const current = this.ledger.get(sessionId)
    if (
      outcome.acceptText ||
      previous?.serverRev !== current?.serverRev ||
      previous?.dirty !== current?.dirty
    )
      this.schedulePersist()
    if (outcome.resend) this.scheduleSend(sessionId, false)
  }

  start(): void {
    if (this.started || this.disposed) return
    this.started = true
    let health = this.options.hub.connectionHealth().status
    this.stops.push(
      this.options.hub.on('sessionDraft', (id, text, meta) =>
        this.adoptRemote(id, { text, ...(meta?.rev !== undefined ? { rev: meta.rev } : {}) }),
      ),
    )
    this.stops.push(
      this.options.hub.on('connectionHealth', (next) => {
        if (next.status === 'ok' && health !== 'ok') this.flushDirty()
        health = next.status
      }),
    )
    if (this.options.pagehide) this.stops.push(this.options.pagehide.subscribe(() => this.flush()))
    else if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      const flush = () => this.flush()
      window.addEventListener('pagehide', flush)
      this.stops.push(() => window.removeEventListener('pagehide', flush))
    }
  }

  flushDirty(): void {
    if (this.disposed) return
    for (const id of this.ledger.dirtySessions()) this.scheduleSend(id, true)
  }

  private scheduleSend(id: SessionId, immediate: boolean): void {
    const existing = this.sendTimers.get(id)
    if (existing !== undefined) clearTimeout(existing)
    this.sendTimers.delete(id)
    if (immediate) {
      this.sendNow(id)
      return
    }
    const timer = setTimeout(() => {
      this.sendTimers.delete(id)
      this.sendNow(id)
    }, this.options.sendDebounceMs ?? DRAFT_SEND_DEBOUNCE_MS)
    timer.unref?.()
    this.sendTimers.set(id, timer)
  }

  private sendNow(id: SessionId): void {
    if (this.disposed) return
    const local = this.ledger.get(id)
    if (local?.dirty) this.options.hub.sendDraftEdit(id, local.serverRev, local.text)
  }

  private schedulePersist(): void {
    if (this.persistTimer !== null) return
    const timer = setTimeout(() => {
      this.persistTimer = null
      this.persist()
    }, this.options.persistDebounceMs ?? DRAFT_PERSIST_DEBOUNCE_MS)
    timer.unref?.()
    this.persistTimer = timer
  }

  persist(strict = false): void {
    if (this.disposed) return
    if (this.persistTimer !== null) clearTimeout(this.persistTimer)
    this.persistTimer = null
    const snapshot = this.ledger.snapshot()
    const entries = Object.entries(snapshot)
    if (entries.length > DRAFT_KEEP_LIMIT) {
      for (const [id] of entries
        .sort((a, b) => b[1].editedAt - a[1].editedAt)
        .slice(DRAFT_KEEP_LIMIT)) {
        this.ledger.remove(id as SessionId)
        delete snapshot[id]
      }
    }
    try {
      this.options.storage.set(
        DRAFTS_UI_KEY,
        entries.length === 0 ? null : JSON.stringify(snapshot),
      )
    } catch (err) {
      if (this.options.onStorageError) this.options.onStorageError(err)
      else log.warn('could not cache this device drafts', { err })
      if (strict) throw err
    }
  }

  flush(strict = false): void {
    if (this.persistTimer !== null) clearTimeout(this.persistTimer)
    this.persistTimer = null
    this.flushDirty()
    this.persist(strict)
  }

  /** Restartable provider teardown preserves the ledger and its last keystroke. */
  stop(): void {
    this.started = false
    for (const stop of this.stops.splice(0)) stop()
    for (const timer of this.sendTimers.values()) clearTimeout(timer)
    this.sendTimers.clear()
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
      this.persist()
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.flush()
    this.stop()
    this.disposed = true
  }
}
