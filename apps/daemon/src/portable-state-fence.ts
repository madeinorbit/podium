/** Raised when portable-state mutation is attempted while a server transfer is fenced. */
export class PortableStateFencedError extends Error {
  constructor() {
    super('portable state writes are paused for server transfer')
    this.name = 'PortableStateFencedError'
  }
}

/** The source-transfer orchestration surface exposed by the daemon process. */
export interface PortableStateControl {
  /** Reject new writers immediately, then wait for every admitted writer to finish. */
  pauseAndDrain(): Promise<void>
  /** Re-admit writers after a confirmed safe abort. */
  resume(): void
}

/**
 * One process-wide admission fence for daemon-owned portable-state writers.
 *
 * Admission and the active count are changed synchronously on the daemon event loop. Once
 * pauseAndDrain flips admission closed, no later upload or cleanup task can enter, while the
 * returned promise accounts for every writer that entered before the pause.
 */
export class PortableStateFence implements PortableStateControl {
  private accepting = true
  private active = 0
  private drainPromise: Promise<void> | undefined
  private resolveDrain: (() => void) | undefined

  private enter(): () => void {
    if (!this.accepting) throw new PortableStateFencedError()
    this.active += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.active -= 1
      if (this.active === 0 && this.resolveDrain) {
        const resolve = this.resolveDrain
        this.resolveDrain = undefined
        this.drainPromise = undefined
        resolve()
      }
    }
  }

  async run<T>(write: () => Promise<T> | T): Promise<T> {
    const leave = this.enter()
    try {
      return await write()
    } finally {
      leave()
    }
  }

  runSync<T>(write: () => T): T {
    const leave = this.enter()
    try {
      return write()
    } finally {
      leave()
    }
  }

  pauseAndDrain(): Promise<void> {
    this.accepting = false
    if (this.active === 0) return Promise.resolve()
    if (!this.drainPromise) {
      this.drainPromise = new Promise<void>((resolve) => {
        this.resolveDrain = resolve
      })
    }
    return this.drainPromise
  }

  resume(): void {
    this.accepting = true
  }
}
