import { Buffer } from 'node:buffer'
import type { SessionId } from '@podium/model'
import type { DaemonPtyOutputBatch } from '@podium/protocol'
export type Tier = 0 | 1 | 2 | 3

export interface OutputSchedulerDeps {
  /** Send one typed, coalesced output batch for a session. */
  flush: (batch: DaemonPtyOutputBatch) => void
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (h: unknown) => void
  scheduleImmediate?: (fn: () => void) => void
  coalesceMs?: number
  coalesceMaxBytes?: number
}

interface Pending { frames: Uint8Array[]; bytes: number; tier: Tier; timer: unknown; immediate: boolean }

/**
 * Per-session PTY-frame relay scheduler. Collapses many per-frame sends into one
 * batched send: P0/P1 (focused/visible) flush on the next tick (≈immediate, kills
 * the per-frame encode+send overhead with ~0 added latency); P2/P3 (attached/
 * unwatched) coalesce on a timer or a byte cap so a background flood never hitches
 * the loop carrying the focused session's echo.
 */
export class OutputScheduler {
  private readonly pending = new Map<SessionId, Pending>()
  private readonly setTimer: NonNullable<OutputSchedulerDeps['setTimer']>
  private readonly clearTimer: NonNullable<OutputSchedulerDeps['clearTimer']>
  private readonly scheduleImmediate: NonNullable<OutputSchedulerDeps['scheduleImmediate']>
  private readonly coalesceMs: number
  private readonly coalesceMaxBytes: number

  constructor(private readonly deps: OutputSchedulerDeps) {
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
    this.scheduleImmediate = deps.scheduleImmediate ?? ((fn) => queueMicrotask(fn))
    this.coalesceMs = deps.coalesceMs ?? 75
    this.coalesceMaxBytes = deps.coalesceMaxBytes ?? 64 * 1024
  }

  private state(sessionId: SessionId): Pending {
    let p = this.pending.get(sessionId)
    if (!p) {
      p = { frames: [], bytes: 0, tier: 1, timer: undefined, immediate: false }
      this.pending.set(sessionId, p)
    }
    return p
  }

  enqueue(sessionId: SessionId, data: Uint8Array): void {
    const p = this.state(sessionId)
    p.frames.push(data)
    p.bytes += data.byteLength
    if (p.tier <= 1) {
      if (!p.immediate) {
        p.immediate = true
        this.scheduleImmediate(() => this.flush(sessionId))
      }
      return
    }
    if (p.bytes >= this.coalesceMaxBytes) {
      this.flush(sessionId)
      return
    }
    if (p.timer === undefined) p.timer = this.setTimer(() => this.flush(sessionId), this.coalesceMs)
  }

  priorityOf(sessionId: SessionId): Tier {
    return this.state(sessionId).tier
  }

  setPriority(sessionId: SessionId, tier: Tier): void {
    const p = this.state(sessionId)
    if (p.tier === tier) return
    p.tier = tier
    if (p.frames.length > 0) this.flush(sessionId) // don't strand buffered output across a tier change
  }

  /**
   * Send whatever this session is holding, right now.
   *
   * The resize path calls this before it dispatches (POD-3239 B7): bytes the
   * scheduler is sitting on were produced at the OLD grid, so they have to leave
   * ahead of the report that announces the new one. Without it a P2/P3 session
   * can hold up to `coalesceMs` of old-grid output and deliver it AFTER the
   * viewer has already resized its buffer, which is the shredded-frame transient
   * the model calls unacceptable on the daemon-held side of the boundary.
   *
   * Idempotent and cheap: a session holding nothing does nothing.
   */
  flushNow(sessionId: SessionId): void {
    this.flush(sessionId)
  }

  private flush(sessionId: SessionId): void {
    const p = this.pending.get(sessionId)
    if (!p) return
    if (p.timer !== undefined) { this.clearTimer(p.timer); p.timer = undefined }
    p.immediate = false
    if (p.frames.length === 0) return
    const sourceFrames = p.frames.length
    const bytes =
      sourceFrames === 1
        ? p.frames[0]!
        : Buffer.concat(p.frames, p.bytes)
    p.frames = []
    p.bytes = 0
    this.deps.flush({ sessionId, sourceFrames, bytes })
  }

  remove(sessionId: SessionId): void {
    this.flush(sessionId) // flush already clears+nulls the timer
    this.pending.delete(sessionId)
  }

  stop(): void {
    for (const sid of [...this.pending.keys()]) this.remove(sid)
  }
}
