/** A quiet stream saves after settling; a busy stream saves at most once per
 * checkpoint. Leaving flushes the last observed activity, never the new view. */
export const READ_CHECKPOINT_MS = 10_000
export const READ_SETTLE_MS = 1200

export class ReadAcknowledgements {
  private id: string | null = null
  private pending: string | null = null
  private sent: string | null = null
  private checkpoint = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly writes = new Set<Promise<void>>()

  constructor(
    private readonly ports: {
      observe(id: string, at: string): boolean
      allowed(id: string): boolean
      leave(id: string): void
      save(id: string, at: string): void | Promise<void>
    },
  ) {}

  update(id: string | null, at?: string, needsSave = true): void {
    if (this.id !== id) {
      this.flush()
      if (this.id) this.ports.leave(this.id)
      this.id = id
      this.sent = null
      this.checkpoint = Date.now() + READ_CHECKPOINT_MS
    }
    if (!id || !at || !this.ports.observe(id, at)) {
      this.cancel()
      return
    }
    if (!needsSave) {
      this.cancel()
      return
    }
    if (this.sent !== null && at <= this.sent) return
    if (this.pending === null || at > this.pending) this.pending = at
    if (this.sent === null) {
      this.flush()
      return
    }
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = setTimeout(
      () => this.flush(),
      Math.max(0, Math.min(READ_SETTLE_MS, this.checkpoint - Date.now())),
    )
  }

  flush(): void {
    const id = this.id,
      at = this.pending
    this.cancel()
    if (!id || !at || !this.ports.allowed(id)) return
    this.sent = at
    this.checkpoint = Date.now() + READ_CHECKPOINT_MS
    const write = this.ports.save(id, at)
    if (write) {
      this.writes.add(write)
      void write.then(
        () => this.writes.delete(write),
        () => this.writes.delete(write),
      )
    }
  }

  async settle(): Promise<void> {
    this.flush()
    await Promise.all(this.writes)
  }

  private cancel(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.pending = null
  }

  dispose(): void {
    this.flush()
    if (this.id) this.ports.leave(this.id)
    this.id = null
    this.sent = null
  }
}
