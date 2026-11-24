import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { View } from 'react-native'
import { useContentActive, VisibleContent } from '../lib/visible-content'

export type ActivityBounds = { x: number; y: number; width: number; height: number }
type Measure = (receive: (bounds: ActivityBounds) => void) => void
interface ActivityViewport {
  measure(): void
  refresh(): void
  watch(check: () => void): () => void
  intersects(bounds: ActivityBounds): boolean
}
export const ActivityViewportContext = createContext<ActivityViewport | null>(null)

/** Only live lines register. Scroll/layout events measure those few lines,
 * never every transcript row, and only intersection crossings reach React. */
export function useActivityViewport(readBounds: Measure, insets?: { top: number; bottom: number }) {
  const active = useContentActive()
  const current = useRef({ active, top: insets?.top ?? 0, bottom: insets?.bottom ?? 0 })
  const viewport = useMemo<ActivityViewport>(() => {
    let bounds: ActivityBounds | undefined
    let generation = 0
    const checks = new Set<() => void>()
    const refresh = () => {
      if (!current.current.active) return
      for (const check of checks) check()
    }
    return {
      refresh,
      measure() {
        const request = ++generation
        if (!current.current.active) return
        readBounds((next) => {
          if (request !== generation || !current.current.active) return
          bounds = next
          refresh()
        })
      },
      watch(check) {
        checks.add(check)
        return () => {
          checks.delete(check)
        }
      },
      intersects(line) {
        const { active, top, bottom } = current.current
        return (
          !!bounds &&
          active &&
          bounds.width > 0 &&
          bounds.height > top + bottom &&
          line.height > 0 &&
          line.width > 0 &&
          line.x < bounds.x + bounds.width &&
          line.x + line.width > bounds.x &&
          line.y < bounds.y + bounds.height - bottom &&
          line.y + line.height > bounds.y + top
        )
      },
    }
  }, [readBounds])
  useLayoutEffect(() => {
    current.current = { active, top: insets?.top ?? 0, bottom: insets?.bottom ?? 0 }
    viewport.measure()
  }, [viewport, active, insets?.top, insets?.bottom])
  return viewport
}

export function ActivityLine({ children, testID }: { children: ReactNode; testID?: string }) {
  const viewport = useContext(ActivityViewportContext)
  return viewport ? (
    <MeasuredLine viewport={viewport} testID={testID}>
      {children}
    </MeasuredLine>
  ) : (
    children
  )
}

function MeasuredLine({
  viewport,
  children,
  testID,
}: {
  viewport: ActivityViewport
  children: ReactNode
  testID?: string
}) {
  const view = useRef<View>(null)
  const active = useContentActive()
  const [shown, setShown] = useState(false)
  const check = useRef(() => {})
  useLayoutEffect(() => {
    setShown(false)
    let mounted = true
    let request = 0
    let previous = false
    const measure = () => {
      const generation = ++request
      view.current?.measureInWindow((x, y, width, height) => {
        if (!mounted || generation !== request) return
        const next = viewport.intersects({ x, y, width, height })
        if (next !== previous) {
          previous = next
          setShown(next)
        }
      })
    }
    if (!active) {
      check.current = () => {}
      return
    }
    check.current = measure
    const stop = viewport.watch(measure)
    measure()
    return () => {
      mounted = false
      ++request
      stop()
      check.current = () => {}
    }
  }, [viewport, active])
  const layout = useCallback(() => check.current(), [])
  return (
    <View ref={view} collapsable={false} onLayout={layout} testID={testID}>
      <VisibleContent visible={active && shown}>{children}</VisibleContent>
    </View>
  )
}
