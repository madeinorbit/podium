/**
 * THE SOURCE SERVER'S TRANSFER FENCE: the order its writers stop and restart in.
 *
 * A server transfer snapshots the portable state, so every writer of it stops
 * first and restarts after. The order matters for the transcript mirror: its
 * lake parts are written through the file storage, which runs every local
 * write inside the portable fence (POD-6963 design 2.3). The mirror therefore
 * pauses BEFORE the portable fence goes up, and resumes only AFTER it comes
 * down. Paused first, a daemon read answered meanwhile is dropped and its
 * segment resumes from the persisted cursor; fenced first, the same reply's
 * part write would be refused and back the segment off for minutes.
 *
 *   fence:         daemon drain → mirror pause → portable fence → store fence
 *   releaseFence:  store fence → portable fence → mirror resume → daemon resume
 *
 * A failure while fencing undoes the steps already taken, in reverse.
 */

export interface SourceFenceParts {
  /** The co-located daemon's portable writers, when this process hosts one. */
  daemon?: (() => { pauseAndDrain(): Promise<void>; resume(): void } | undefined) | undefined
  mirror: { pause(): Promise<void>; resume(): Promise<void> }
  portable: { acquire(): Promise<void>; release(): void }
  store: { begin(): Promise<void>; end(): Promise<void> }
}

export interface SourceFence {
  fence(): Promise<void>
  releaseFence(): Promise<void>
}

export function sourceTransferFence(parts: SourceFenceParts): SourceFence {
  return {
    async fence() {
      const daemon = parts.daemon?.()
      await daemon?.pauseAndDrain()
      let mirrorPaused = false
      let portableHeld = false
      try {
        await parts.mirror.pause()
        mirrorPaused = true
        await parts.portable.acquire()
        portableHeld = true
        await parts.store.begin()
      } catch (error) {
        if (portableHeld) parts.portable.release()
        if (mirrorPaused) await parts.mirror.resume()
        daemon?.resume()
        throw error
      }
    },
    async releaseFence() {
      await parts.store.end()
      parts.portable.release()
      await parts.mirror.resume()
      parts.daemon?.()?.resume()
    },
  }
}
