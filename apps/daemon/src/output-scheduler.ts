export type Tier = 0 | 1 | 2 | 3

export interface OutputSchedulerDeps {
  /** Send one coalesced batch for a session (caller wraps it as agentFrameBatch). */
  flush: (sessionId: string, frames: string[]) => void
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (h: unknown) => void
  scheduleImmediate?: (fn: () => void) => void
  coalesceMs?: number
  coalesceMaxBytes?: number
}

interface Pending { frames: string[]; bytes: number; tier: Tier; timer: unknown; immediate: boolean }

/**
 * Per-session PTY-frame relay scheduler. Collapses many per-frame sends into one
 * batched send: P0/P1 (focused/visible) flush on the next tick (≈immediate, kills
 * the per-frame encode+send overhead with ~0 added latency); P2/P3 (attached/
 * unwatched) coalesce on a timer or a byte cap so a background flood never hitches
 * the loop carrying the focused session's echo.
 */
export class OutputScheduler {
  private readonly pending = new Map<string, Pending>()
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

  private state(sessionId: string): Pending {
    let p = this.pending.get(sessionId)
    if (!p) {
      p = { frames: [], bytes: 0, tier: 1, timer: undefined, immediate: false }
      this.pending.set(sessionId, p)
    }
    return p
  }

  enqueue(sessionId: string, data: string): void {
    const p = this.state(sessionId)
    p.frames.push(data)
    p.bytes += data.length
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

  priorityOf(sessionId: string): Tier {
    return this.state(sessionId).tier
  }

  setPriority(sessionId: string, tier: Tier): void {
    const p = this.state(sessionId)
    if (p.tier === tier) return
    p.tier = tier
    if (p.frames.length > 0) this.flush(sessionId) // don't strand buffered output across a tier change
  }

  private flush(sessionId: string): void {
    const p = this.pending.get(sessionId)
    if (!p) return
    if (p.timer !== undefined) { this.clearTimer(p.timer); p.timer = undefined }
    p.immediate = false
    if (p.frames.length === 0) return
    const frames = p.frames
    p.frames = []
    p.bytes = 0
    this.deps.flush(sessionId, frames)
  }

  remove(sessionId: string): void {
    this.flush(sessionId) // flush already clears+nulls the timer
    this.pending.delete(sessionId)
  }

  stop(): void {
    for (const sid of [...this.pending.keys()]) this.remove(sid)
  }
}
