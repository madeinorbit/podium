import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, cleanup, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReducedMotionContext } from '../hooks/useReduceMotion'
import { VisibleContent } from '../lib/visible-content'
import { workingMarkRest, workingMarkSamples } from './working-mark-frames'

type Props = Record<string, unknown> & { children?: ReactNode }
const native = vi.hoisted(() => ({
  views: [] as { name: string; props: Record<string, unknown> }[],
  frames: [] as unknown[][],
  app: 'active',
  appListeners: new Set<() => void>(),
  focused: true,
  focusListeners: new Set<() => void>(),
}))
vi.mock('expo', () => ({
  requireNativeView: (_module: string, name: string) =>
    function NativeView({ children, ...props }: Props) {
      native.views.push({ name, props })
      return <div data-native={name}>{children}</div>
    },
  requireNativeModule: () => ({
    setWorkingMarkFrames: (...args: unknown[]) => native.frames.push(args),
  }),
}))
vi.mock('react-native', async (original) => ({
  ...(await original<typeof import('react-native')>()),
  AppState: {
    get currentState() {
      return native.app
    },
    addEventListener: (_event: string, listener: () => void) => {
      native.appListeners.add(listener)
      return { remove: () => native.appListeners.delete(listener) }
    },
  },
}))
vi.mock('../client/projection-focus', async () => {
  const { useSyncExternalStore } = await import('react')
  return {
    useProjectionFocus: () =>
      useSyncExternalStore(
        (listener) => {
          native.focusListeners.add(listener)
          return () => {
            native.focusListeners.delete(listener)
          }
        },
        () => native.focused,
      ),
  }
})

const { WorkingMark } = await import('./WorkingMark.ios')
const { WorkingWord } = await import('./WorkingWord.ios')
const { workingWordPhase } = await import('./WorkingWord.shared')
const { CaretMotion } = await import('./streaming-caret-motion.ios')

beforeEach(() => {
  native.views.length = 0
  native.app = 'active'
  native.focused = true
})
afterEach(cleanup)

const last = (name: string) => native.views.filter((view) => view.name === name).at(-1)?.props
const setFocus = (focused: boolean) =>
  act(() => {
    native.focused = focused
    for (const notify of native.focusListeners) notify()
  })
const setApp = (state: string) =>
  act(() => {
    native.app = state
    for (const notify of native.appListeners) notify()
  })
function Scene({
  visible = true,
  reduced = false,
  children,
}: {
  visible?: boolean
  reduced?: boolean
  children: ReactNode
}) {
  return (
    <ReducedMotionContext value={reduced}>
      <VisibleContent visible={visible}>{children}</VisibleContent>
    </ReducedMotionContext>
  )
}

describe('iOS WorkingMark', () => {
  it('hands native the shared tetra table once: same samples, rest picture and 4s loop', () => {
    expect(native.frames).toHaveLength(1)
    const [samples, dots, rest, loop] = native.frames[0] as [number[], number, number[], number]
    expect(dots).toBe(4)
    expect(loop).toBe(4000)
    expect(rest).toEqual(workingMarkRest.flat())
    expect(samples).toHaveLength(workingMarkSamples.length * 4 * 5)
    expect(samples.slice(20, 40)).toEqual(workingMarkSamples[1]?.flat())
  })

  it('keeps the cell geometry, tint and hidden accessibility of the RN mark', () => {
    render(<WorkingMark size={18} tint="#123456" />)
    expect(last('PodiumWorkingMarkView')).toMatchObject({
      testID: 'working-mark',
      tint: '#123456',
      active: true,
      accessible: false,
      accessibilityElementsHidden: true,
      importantForAccessibility: 'no-hide-descendants',
      pointerEvents: 'none',
      style: { width: 12, height: 18 },
    })
  })

  it('stops on hidden pages, blur and Reduce Motion, and resumes on return', () => {
    const { rerender } = render(
      <Scene>
        <WorkingMark />
      </Scene>,
    )
    expect(last('PodiumWorkingMarkView')?.active).toBe(true)
    rerender(
      <Scene visible={false}>
        <WorkingMark />
      </Scene>,
    )
    expect(last('PodiumWorkingMarkView')?.active).toBe(false)
    rerender(
      <Scene reduced>
        <WorkingMark />
      </Scene>,
    )
    expect(last('PodiumWorkingMarkView')?.active).toBe(false)
    rerender(
      <Scene>
        <WorkingMark />
      </Scene>,
    )
    expect(last('PodiumWorkingMarkView')?.active).toBe(true)
    setFocus(false)
    expect(last('PodiumWorkingMarkView')?.active).toBe(false)
    setFocus(true)
    expect(last('PodiumWorkingMarkView')?.active).toBe(true)
  })
})

describe('iOS WorkingWord', () => {
  const word = (props: { visible?: boolean; reduced?: boolean; active?: boolean } = {}) => (
    <Scene visible={props.visible} reduced={props.reduced}>
      <WorkingWord seed="POD-7" active={props.active}>
        Working
      </WorkingWord>
    </Scene>
  )

  it('mounts the native glint with the desktop seed phase over a hidden bright copy', () => {
    const view = render(word())
    expect(last('PodiumWorkingGlintView')).toMatchObject({
      active: true,
      phase: workingWordPhase('POD-7'),
      accessibilityElementsHidden: true,
      importantForAccessibility: 'no-hide-descendants',
      testID: 'working-word-glint',
    })
    // The readable text stays outside the glint.
    expect(view.container.textContent).toBe('WorkingWorking')
  })

  it.each([
    ['hidden', { visible: false }],
    ['Reduce Motion', { reduced: true }],
    ['quiet', { active: false }],
  ])('mounts no glint for %s words', (_name, props) => {
    const view = render(word(props))
    expect(last('PodiumWorkingGlintView')).toBeUndefined()
    expect(view.container.textContent).toBe('Working')
  })

  it('removes the glint on blur and restores it on focus', () => {
    const view = render(word())
    setFocus(false)
    expect(view.container.querySelector('[data-native="PodiumWorkingGlintView"]')).toBeNull()
    setFocus(true)
    expect(view.container.querySelector('[data-native="PodiumWorkingGlintView"]')).not.toBeNull()
  })
})

describe('iOS streaming caret', () => {
  const caret = (props: { visible?: boolean; reduced?: boolean } = {}) => (
    <Scene visible={props.visible}>
      <CaretMotion reduceMotion={props.reduced ?? false} />
    </Scene>
  )

  it('blinks only while visible, foreground and motion-enabled', () => {
    const { rerender } = render(caret())
    expect(last('PodiumBlinkView')?.active).toBe(true)
    setApp('background')
    expect(last('PodiumBlinkView')?.active).toBe(false)
    setApp('active')
    expect(last('PodiumBlinkView')?.active).toBe(true)
    rerender(caret({ reduced: true }))
    expect(last('PodiumBlinkView')?.active).toBe(false)
    rerender(caret({ visible: false }))
    expect(last('PodiumBlinkView')?.active).toBe(false)
    rerender(caret())
    expect(last('PodiumBlinkView')?.active).toBe(true)
  })
})

describe('native Working motion source', () => {
  const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8')
  const swift = read('modules/podium-list-row/ios/WorkingMotionViews.swift').replace(
    /\/\/.*$/gm,
    '',
  )
  const module = read('modules/podium-list-row/ios/PodiumListRowModule.swift')

  it('registers every view the JS wrappers require', () => {
    for (const name of ['PodiumWorkingMarkView', 'PodiumWorkingGlintView', 'PodiumBlinkView']) {
      expect(module).toContain(`View(${name}.self)`)
      expect(swift).toContain(`final class ${name}: CoreMotionView`)
    }
    expect(module).toContain('Function("setWorkingMarkFrames")')
  })

  it('hands loops to Core Animation and computes no frames in the app', () => {
    expect(swift).not.toMatch(/CADisplayLink|Timer|TimelineView|DispatchQueue/)
    expect(swift).toContain('animation.repeatCount = .infinity')
    expect(swift).toContain('let should = active && foreground && window != nil')
    expect(swift).toContain('UIApplication.willResignActiveNotification')
    expect(swift).toContain('UIApplication.didBecomeActiveNotification')
  })

  it('keeps the desktop glint timing', () => {
    expect(swift).toContain('period: CFTimeInterval = 2.2')
    expect(swift).toContain('travel.keyTimes = [0, 0.66, 1]')
    expect(swift).toContain('CAMediaTimingFunction(controlPoints: 0.42, 0, 0.58, 1)')
    expect(swift).toContain('travel.timeOffset = phase * Self.period')
  })
})
