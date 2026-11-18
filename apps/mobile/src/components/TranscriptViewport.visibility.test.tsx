import type { ChatBlock } from '@podium/client-core/values'
import type { CellRendererProps } from '@react-native/virtualized-lists'
import { act, cleanup, render, screen } from '@testing-library/react'
import type { ComponentPropsWithRef, ComponentType, ReactNode } from 'react'
import type {
  FlatListProps,
  NativeScrollEvent,
  NativeSyntheticEvent,
  View as RNView,
} from 'react-native'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useContentVisible } from '../lib/visible-content'
import { ToolsRun, TranscriptTail } from './TranscriptList'
import { TranscriptViewport } from './TranscriptViewport.native'
import { ActivityLine } from './transcript-activity'

const native = vi.hoisted(() => ({
  props: undefined as FlatListProps<string> | undefined,
  root: { x: 0, y: 0, width: 300, height: 400 },
  line: { x: 0, y: 100, width: 300, height: 30 },
  delay: false,
  pending: [] as (() => void)[],
}))
vi.mock('react-native', async (original) => {
  const actual = await original<typeof import('react-native')>()
  const { forwardRef, useImperativeHandle, useRef } = await import('react')
  return {
    ...actual,
    View: ({ ref, ...props }: ComponentPropsWithRef<typeof RNView>) => {
      const element = useRef<RNView>(null)
      useImperativeHandle(ref, () => {
        const node = element.current
        if (!node) throw new Error('Missing measured native view')
        if (
          props.testID === 'transcript-live-line' ||
          props.testID === 'test-live-line' ||
          props.testID === 'streaming-caret-line'
        ) {
          node.measureInWindow = (callback) => {
            const { x, y, width, height } = native.line
            const deliver = () => callback(x, y, width, height)
            if (native.delay) native.pending.push(deliver)
            else deliver()
          }
        }
        return node
      }, [props.testID])
      return <actual.View {...props} ref={element} />
    },
    FlatList: forwardRef((props: FlatListProps<string>, ref) => {
      native.props = props
      useImperativeHandle(
        ref,
        () => ({
          getNativeScrollRef: () => ({
            measureInWindow: (
              callback: (x: number, y: number, width: number, height: number) => void,
            ) => {
              const { x, y, width, height } = native.root
              callback(x, y, width, height)
            },
          }),
          scrollToOffset() {},
        }),
        [],
      )
      const Cell = props.CellRendererComponent as ComponentType<CellRendererProps<string>>
      return (
        <div>
          {Array.from(props.data ?? []).map((item, index) => (
            <Cell key={item} cellKey={item} index={index} item={item} style={undefined}>
              {props.renderItem?.({
                item,
                index,
                separators: { highlight() {}, unhighlight() {}, updateProps() {} },
              })}
            </Cell>
          ))}
          {props.ListFooterComponent as ReactNode}
        </div>
      )
    }),
  }
})
vi.mock('react-native-screens/experimental', () => ({
  ScrollViewMarker: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
vi.mock('./WorkingMark', () => ({
  WorkingMark: () => <span data-testid="mark-active">{String(useContentVisible())}</span>,
}))
vi.mock('./ToolCallRow', () => ({
  ToolCallRow: () => <div style={{ height: 1000 }}>Expanded results</div>,
}))
vi.mock('./SharedFiles', () => ({ SharedFiles: () => null }))
vi.mock('./PressableScale', () => ({
  PressableScale: ({ children, onPress }: { children: ReactNode; onPress(): void }) => (
    <button type="button" onClick={onPress}>
      {children}
    </button>
  ),
}))
vi.mock('expo-haptics', () => ({ selectionAsync: async () => {}, impactAsync: async () => {} }))
vi.mock('expo-clipboard', () => ({ setStringAsync: async () => {} }))
const start = Date.parse('2026-11-18T12:00:00Z')
const block = {
  item: {
    id: 'call',
    role: 'tool',
    ts: new Date(start - 5000).toISOString(),
    toolName: 'Bash',
    toolInputJson: '{"command":"git status"}',
  },
} as ChatBlock
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(start)
  native.root.height = 400
  native.line.y = 100
  native.delay = false
  native.pending.length = 0
})
afterEach(() => {
  cleanup()
  expect(vi.getTimerCount()).toBe(0)
  vi.useRealTimers()
})
const scroll = (offset = 0) =>
  ({
    nativeEvent: {
      contentOffset: { x: 0, y: offset },
      contentSize: { width: 300, height: 2100 },
      layoutMeasurement: { width: 300, height: native.root.height },
    },
  }) as NativeSyntheticEvent<NativeScrollEvent>
const viewport = (line: ReactNode, insets = { top: 0, bottom: 0 }, identity = 'cell') => (
  <TranscriptViewport
    identity="chat"
    data={[identity]}
    keyExtractor={(key) => key}
    positionOfKey={() => 0}
    renderItem={() => <>{line}</>}
    visibleInsets={insets}
  />
)

it('stops an expanded live tool header while its tall result body remains on screen', () => {
  render(viewport(<ToolsRun blocks={[block]} live forceOpen />))
  expect(screen.getByTestId('mark-active').textContent).toBe('true')
  expect(vi.getTimerCount()).toBe(1)
  expect(screen.getByText('Expanded results')).toBeTruthy()
  act(() => {
    native.line.y = -100
    native.props?.onScroll?.(scroll(200))
  })
  expect(screen.getByTestId('mark-active').textContent).toBe('false')
  expect(vi.getTimerCount()).toBe(0)
  act(() => {
    native.line.y = 100
    native.props?.onScroll?.(scroll())
  })
  expect(vi.getTimerCount()).toBe(1)
})

it('does not activate an offscreen tail just because a long suffix in the same footer is visible', () => {
  native.root.height = 500
  native.line.y = 870 // content 1970 minus scroll offset 1100
  render(
    <TranscriptViewport
      identity="chat"
      data={[]}
      keyExtractor={(key) => key}
      positionOfKey={() => 0}
      renderItem={() => null}
      ListFooterComponent={
        <>
          <div style={{ height: 1000 }}>Long suffix</div>
          <TranscriptTail state={{ label: 'Working', tone: 'working', since: block.item.ts }} />
        </>
      }
    />,
  )
  expect(screen.getByText('Long suffix')).toBeTruthy()
  expect(screen.getByTestId('mark-active').textContent).toBe('false')
  expect(vi.getTimerCount()).toBe(0)
  act(() => {
    native.line.y = 470
    native.props?.onScroll?.(scroll(1500))
  })
  expect(screen.getByTestId('mark-active').textContent).toBe('true')
  expect(vi.getTimerCount()).toBe(1)
})

it('rechecks ordinary live lines for composer, keyboard and header inset-only changes', () => {
  native.line.y = 350
  const line = <ToolsRun blocks={[block]} live />
  const view = render(viewport(line))
  expect(vi.getTimerCount()).toBe(1)
  view.rerender(viewport(line, { top: 0, bottom: 100 }))
  expect(screen.getByTestId('mark-active').textContent).toBe('false')
  expect(vi.getTimerCount()).toBe(0)
  act(() => {
    native.line.y = 20
    native.props?.onScroll?.(scroll())
  })
  view.rerender(viewport(line, { top: 100, bottom: 0 }))
  expect(vi.getTimerCount()).toBe(0)
  view.rerender(viewport(line))
  expect(vi.getTimerCount()).toBe(1)
})

it('ignores late geometry callbacks after a native cell is recycled or unmounted', () => {
  function Probe() {
    return <span data-testid="probe">{String(useContentVisible())}</span>
  }
  const line = (
    <ActivityLine testID="test-live-line">
      <Probe />
    </ActivityLine>
  )
  const view = render(viewport(line))
  expect(screen.getByTestId('probe').textContent).toBe('true')
  native.delay = true
  act(() => native.props?.onScroll?.(scroll()))
  const late = [...native.pending]
  native.delay = false
  native.line.y = 500
  view.rerender(viewport(line, { top: 0, bottom: 0 }, 'recycled'))
  act(() => {
    for (const deliver of late) deliver()
  })
  expect(screen.getByTestId('probe').textContent).toBe('false')
  view.unmount()
  act(() => {
    for (const deliver of late) deliver()
  })
})

it('stops the actual streaming caret loop when its own line leaves a tall response or is occluded', async () => {
  const { Animated } = await import('react-native')
  const { StreamingCaret } = await import('./StreamingCaret')
  const start = vi.fn(),
    stop = vi.fn()
  const loop = vi.spyOn(Animated, 'loop').mockReturnValue({ start, stop, reset() {} })
  const line = (
    <>
      <div style={{ height: 1000 }}>Long response</div>
      <StreamingCaret reduceMotion={false} />
    </>
  )
  const view = render(viewport(line))
  expect(start).toHaveBeenCalledTimes(1)
  act(() => {
    native.line.y = 500
    native.props?.onScroll?.(scroll())
  })
  expect(stop).toHaveBeenCalledTimes(1)
  act(() => {
    native.line.y = 350
    native.props?.onScroll?.(scroll())
  })
  expect(start).toHaveBeenCalledTimes(2)
  view.rerender(viewport(line, { top: 0, bottom: 100 }))
  expect(stop).toHaveBeenCalledTimes(2)
  view.unmount()
  loop.mockRestore()
})
