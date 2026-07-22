export const ASCII_ANIMATION_FRAME_INTERVAL_MS = 80

type AsciiAnimationOptions<T> = {
  renderStatic: () => T
  renderFrame: (elapsedSeconds: number) => T
  commit: (frame: T) => void
  reducedMotion: boolean
  frameIntervalMs?: number
}

/**
 * Runs a low-frequency ASCII animation on RAF so drawing stays aligned with paint.
 * Hidden documents keep one static frame and schedule no animation work.
 */
export function startAsciiAnimation<T>({
  renderStatic,
  renderFrame,
  commit,
  reducedMotion,
  frameIntervalMs = ASCII_ANIMATION_FRAME_INTERVAL_MS,
}: AsciiAnimationOptions<T>): () => void {
  commit(renderStatic())
  if (reducedMotion) return () => {}

  const startedAt = performance.now()
  let lastFrameAt = Number.NEGATIVE_INFINITY
  let raf: number | null = null
  let disposed = false

  const loop = (timestamp: number): void => {
    raf = null
    if (disposed || document.visibilityState === 'hidden') return

    if (timestamp - lastFrameAt >= frameIntervalMs) {
      commit(renderFrame((timestamp - startedAt) / 1000))
      lastFrameAt = timestamp
    }
    raf = requestAnimationFrame(loop)
  }

  const resume = (): void => {
    if (disposed || document.visibilityState === 'hidden' || raf !== null) return
    raf = requestAnimationFrame(loop)
  }

  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') {
      if (raf !== null) cancelAnimationFrame(raf)
      raf = null
      return
    }
    resume()
  }

  document.addEventListener('visibilitychange', onVisibilityChange)
  resume()

  return () => {
    disposed = true
    document.removeEventListener('visibilitychange', onVisibilityChange)
    if (raf !== null) cancelAnimationFrame(raf)
    raf = null
  }
}

/** Assigning a large text node can be costly even when its contents did not change. */
export function setTextIfChanged(node: Node, text: string): void {
  if (node.textContent !== text) node.textContent = text
}
