import type { CellRendererProps } from '@react-native/virtualized-lists'
import { act, cleanup, render, screen } from '@testing-library/react'
import type { ComponentType, ReactNode } from 'react'
import type {
  FlatListProps,
  LayoutChangeEvent,
  NativeScrollEvent,
  NativeSyntheticEvent,
} from 'react-native'
import { afterEach, expect, it, vi } from 'vitest'
import { useContentVisible } from '../lib/visible-content'
import { TranscriptViewport } from './TranscriptViewport.native'

const native = vi.hoisted(() => ({ props: undefined as FlatListProps<string> | undefined }))
vi.mock('react-native', async (original) => {
  const actual = await original<typeof import('react-native')>()
  const { forwardRef } = await import('react')
  return {
    ...actual,
    FlatList: forwardRef((props: FlatListProps<string>, _ref) => {
      native.props = props
      const Cell = props.CellRendererComponent as ComponentType<CellRendererProps<string>>
      return (
        <div>
          <Cell cellKey="visible" index={0} item="visible" style={undefined}>
            <Probe id="row" />
          </Cell>
          <Cell cellKey="prefetched" index={1} item="prefetched" style={undefined}>
            <Probe id="prefetch" />
          </Cell>
          {props.ListFooterComponent as ReactNode}
        </div>
      )
    }),
  }
})
vi.mock('react-native-screens/experimental', () => ({
  ScrollViewMarker: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
afterEach(cleanup)
function Probe({ id }: { id: string }) {
  return <span data-testid={id}>{String(useContentVisible())}</span>
}
const layout = (height: number) =>
  ({ nativeEvent: { layout: { x: 0, y: 0, width: 300, height } } }) as LayoutChangeEvent
const scroll = (offset: number) =>
  ({
    nativeEvent: {
      contentOffset: { x: 0, y: offset },
      contentSize: { width: 300, height: 1_000 },
      layoutMeasurement: { width: 300, height: 400 },
    },
  }) as NativeSyntheticEvent<NativeScrollEvent>

it('keeps prefetched cells inactive and stops a row when it leaves native viewability', () => {
  render(
    <TranscriptViewport
      identity="chat"
      data={['visible', 'prefetched']}
      positionOfKey={() => 0}
      keyExtractor={(key) => key}
      renderItem={() => null}
    />,
  )
  expect(screen.getByTestId('row').textContent).toBe('false')
  act(() =>
    native.props?.onViewableItemsChanged?.({
      viewableItems: [{ key: 'visible', item: 'visible', index: 0, isViewable: true }],
      changed: [],
    }),
  )
  expect(screen.getByTestId('row').textContent).toBe('true')
  expect(screen.getByTestId('prefetch').textContent).toBe('false')
  act(() => native.props?.onViewableItemsChanged?.({ viewableItems: [], changed: [] }))
  expect(screen.getByTestId('row').textContent).toBe('false')
})

it('gates the live footer by intersection instead of following intent or mounted state', () => {
  render(
    <TranscriptViewport
      identity="chat"
      data={['visible']}
      positionOfKey={() => 0}
      keyExtractor={(key) => key}
      renderItem={() => null}
      ListFooterComponent={<Probe id="footer" />}
      contentContainerStyle={{ paddingBottom: 100 }}
    />,
  )
  // The native footer wrapper reports its height; FlatList reports scroll geometry.
  const footer = native.props?.ListFooterComponent as {
    props: { onLayout(event: LayoutChangeEvent): void }
  }
  act(() => {
    footer.props.onLayout(layout(100))
    native.props?.onLayout?.(layout(400))
    native.props?.onContentSizeChange?.(300, 1_000)
    native.props?.onScroll?.(scroll(0))
  })
  expect(screen.getByTestId('footer').textContent).toBe('false')
  act(() => native.props?.onScroll?.(scroll(450)))
  expect(screen.getByTestId('footer').textContent).toBe('true')
  act(() => native.props?.onScroll?.(scroll(100)))
  expect(screen.getByTestId('footer').textContent).toBe('false')
})

it('stops footer activity when the composer or keyboard covers it without a scroll event', () => {
  const viewport = (bottom: number) => (
    <TranscriptViewport
      identity="chat"
      data={['visible']}
      positionOfKey={() => 0}
      keyExtractor={(key) => key}
      renderItem={() => null}
      ListFooterComponent={<Probe id="footer" />}
      visibleInsets={{ top: 0, bottom }}
      contentContainerStyle={{ paddingBottom: 100 }}
    />
  )
  const view = render(viewport(0))
  const footer = native.props?.ListFooterComponent as {
    props: { onLayout(event: LayoutChangeEvent): void }
  }
  act(() => {
    footer.props.onLayout(layout(100))
    native.props?.onScroll?.(scroll(450))
  })
  expect(screen.getByTestId('footer').textContent).toBe('true')
  view.rerender(viewport(150))
  expect(screen.getByTestId('footer').textContent).toBe('false')
  view.rerender(viewport(0))
  expect(screen.getByTestId('footer').textContent).toBe('true')
})
