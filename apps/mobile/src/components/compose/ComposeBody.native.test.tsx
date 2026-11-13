import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps, ReactNode } from 'react'
import { type ScrollView, StyleSheet, type TextInput, type View } from 'react-native'
import { afterEach, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  input: undefined as ComponentProps<typeof TextInput> | undefined,
  scroll: undefined as ComponentProps<typeof ScrollView> | undefined,
  layouts: new Map<string, ComponentProps<typeof View>['onLayout']>(),
  dismiss: vi.fn(),
}))
vi.mock('react-native', async (original) => {
  const rn = await original<typeof import('react-native')>()
  const { forwardRef } = await import('react')
  return {
    ...rn,
    Platform: { ...rn.Platform, OS: 'ios' },
    Keyboard: { ...rn.Keyboard, dismiss: native.dismiss },
    View: forwardRef<View, ComponentProps<typeof View>>((props, ref) => {
      if (props.testID) native.layouts.set(props.testID, props.onLayout)
      return <rn.View {...props} ref={ref} onLayout={undefined} />
    }),
    ScrollView: forwardRef<ScrollView, ComponentProps<typeof ScrollView>>((props, ref) => {
      if (!props.horizontal) native.scroll = props
      if (props.testID) native.layouts.set(props.testID, props.onLayout)
      return <rn.ScrollView {...props} ref={ref} onLayout={undefined} />
    }),
    TextInput: forwardRef<TextInput, ComponentProps<typeof TextInput>>((props, ref) => {
      native.input = props
      return <rn.TextInput {...props} ref={ref} onContentSizeChange={undefined} />
    }),
  }
})
// Yoga/UITextView measurements enter through their native callbacks. The RN
// controls and PressableScale remain mounted so inherited hit areas are tested.
vi.mock('../composer-measure', () => ({ useComposerMeasure: () => {} }))
vi.mock('./ComposeMenu', () => ({
  ComposeMenu: ({ children }: { children: () => ReactNode }) => children(),
}))
vi.mock('../Icon', () => ({
  Icon: ({ as, size }: { as: string; size: number }) => (
    <span data-testid={as} style={{ width: size, height: size }} />
  ),
}))
vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light' },
  impactAsync: async () => {},
}))

const { ComposeBody, ComposeFieldRow } = await import('./ComposeBody')
const props: ComponentProps<typeof ComposeBody> = {
  fields: <ComposeFieldRow label="Project" value="podium" items={[]} />,
  prompt: '',
  onPrompt: vi.fn(),
  onStart: vi.fn(),
  onCancel: vi.fn(),
  onCoordinator: vi.fn(),
  attachments: [],
  onRemoveAttachment: vi.fn(),
  busy: false,
  bottomInset: 0,
}
const layout = (id: string, height: number) =>
  act(() =>
    native.layouts.get(id)?.({
      nativeEvent: { layout: { x: 0, y: 0, width: 390, height } },
    } as never),
  )
const content = (height: number) =>
  act(() =>
    native.input?.onContentSizeChange?.({
      nativeEvent: { contentSize: { width: 390, height } },
    } as never),
  )
afterEach(() => {
  cleanup()
  native.layouts.clear()
  vi.clearAllMocks()
})

it('lets native text grow to ten lines, scrolls at the available height, and shrinks again', () => {
  const { rerender } = render(<ComposeBody {...props} />)
  layout('compose-scroll', 600)
  layout('compose-fields', 132)
  layout('compose-footer', 34)
  rerender(
    <ComposeBody
      {...props}
      prompt={Array.from({ length: 10 }, (_, i) => `Line ${i + 1}`).join('\n')}
    />,
  )
  content(232)
  expect(StyleSheet.flatten(native.input?.style)).not.toHaveProperty('height')
  expect(StyleSheet.flatten(native.input?.style)?.maxHeight).toBe(418)
  expect(native.input?.scrollEnabled).toBe(false)
  act(() =>
    native.scroll?.onScroll?.({ nativeEvent: { contentInset: { top: 64, bottom: 0 } } } as never),
  )
  expect(StyleSheet.flatten(native.input?.style)?.maxHeight).toBe(354)
  layout('compose-scroll', 340)
  expect(StyleSheet.flatten(native.input?.style)?.maxHeight).toBe(94)
  expect(native.input?.scrollEnabled).toBe(true)
  content(56)
  expect(native.input?.scrollEnabled).toBe(false)
  expect(StyleSheet.flatten(native.input?.style)).not.toHaveProperty('height')
})

it('keeps full-width rows, a small corner badge with a full hit area, and a keyboard dismissal target', () => {
  render(
    <ComposeBody
      {...props}
      attachments={[
        {
          id: 'photo',
          name: 'photo.jpg',
          previewUri: 'file:///photo.jpg',
          state: 'ready',
        } as never,
      ]}
    />,
  )
  const row = screen.getByRole('button', { name: 'Project, podium' })
  expect(getComputedStyle(row).width).toBe('100%')
  expect(getComputedStyle(screen.getByText('Project')).width).toBe('68px')
  const remove = screen.getByRole('button', { name: 'Remove photo.jpg' })
  const badge = screen.getByTestId('xmark.circle.fill')
  expect(getComputedStyle(remove).width).toBe('44px')
  expect(getComputedStyle(remove).backgroundColor).toMatch(/, 0(?:\.0+)?\)$/)
  expect(getComputedStyle(badge.parentElement as HTMLElement).width).toBe('20px')
  fireEvent.click(remove)
  expect(props.onRemoveAttachment).toHaveBeenCalledWith('photo')
  fireEvent.click(screen.getByTestId('compose-dismiss-keyboard'))
  expect(native.dismiss).toHaveBeenCalledOnce()
})
