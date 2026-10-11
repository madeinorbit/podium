import { dotsAt, restingPicture } from '@podium/working-mark/frames'
import { tetra } from '@podium/working-mark/designs'
import type { Picture } from '@podium/working-mark'

/** One native clock for all visible tetra marks; paused marks own no frame timer. */
export function createWorkingMarkClock() {
  const painters = new Set<(picture: Picture) => void>()
  const rest = restingPicture(tetra)
  let active = true
  let focused = true
  let lastInput = Date.now()
  let frames: ReturnType<typeof setInterval> | undefined
  let idle: ReturnType<typeof setTimeout> | undefined

  const paint = (picture: Picture) => {
    for (const painter of painters) painter(picture)
  }
  const stop = () => {
    clearInterval(frames)
    clearTimeout(idle)
    frames = idle = undefined
  }
  const reconcile = () => {
    stop()
    const remaining = 5000 - (Date.now() - lastInput)
    if (!painters.size) return
    if (!active || !focused || remaining <= 0) {
      paint(rest)
      return
    }
    const tick = () => paint(dotsAt(tetra, Date.now() % tetra.loop))
    tick()
    frames = setInterval(tick, 1000 / 15)
    idle = setTimeout(reconcile, remaining)
  }
  return {
    subscribe(painter: (picture: Picture) => void) {
      painters.add(painter)
      reconcile()
      return () => {
        painters.delete(painter)
        painter(rest)
        if (!painters.size) stop()
      }
    },
    wake() {
      lastInput = Date.now()
      if (frames !== undefined) {
        clearTimeout(idle)
        idle = setTimeout(reconcile, 5000)
      } else reconcile()
    },
    setActive(value: boolean) {
      active = value
      if (value) lastInput = Date.now()
      reconcile()
    },
    setFocused(value: boolean) {
      focused = value
      if (value) lastInput = Date.now()
      reconcile()
    },
  }
}
