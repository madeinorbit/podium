import { dotsAt, restingPicture } from '@podium/working-mark/frames'
import { tetra } from '@podium/working-mark/designs'
import type { Picture } from '@podium/working-mark'

/** One native clock for all visible tetra marks; it runs whenever a mark is on screen and the app is not in the background. */
export function createWorkingMarkClock() {
  const painters = new Set<(picture: Picture) => void>()
  const rest = restingPicture(tetra)
  let active = true
  let frames: ReturnType<typeof setInterval> | undefined

  const paint = (picture: Picture) => {
    for (const painter of painters) painter(picture)
  }
  const stop = () => {
    clearInterval(frames)
    frames = undefined
  }
  const reconcile = () => {
    stop()
    if (!painters.size) return
    if (!active) {
      paint(rest)
      return
    }
    const tick = () => paint(dotsAt(tetra, Date.now() % tetra.loop))
    tick()
    frames = setInterval(tick, 1000 / 15)
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
    setActive(value: boolean) {
      if (active === value) return
      active = value
      reconcile()
    },
  }
}
