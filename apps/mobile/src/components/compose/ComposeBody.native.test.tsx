import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps, ReactNode } from 'react'
import { type ScrollView, StyleSheet, type Text, type TextInput, type View } from 'react-native'
import { afterEach, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  input: undefined as ComponentProps<typeof TextInput> | undefined,
  scroll: undefined as ComponentProps<typeof ScrollView> | undefined,
  layouts: new Map<string, ComponentProps<typeof View>['onLayout']>(),
  dismiss: vi.fn(),
  scrollTo: vi.fn(),
  fontScale: 1,
}))
vi.mock('react-native', async (original) => {
  const rn = await original<typeof import('react-native')>()
  const { forwardRef, useImperativeHandle } = await import('react')
  return {
    ...rn,
    Platform: { ...rn.Platform, OS: 'ios' },
    useWindowDimensions: () => ({ width: 390, height: 844, scale: 3, fontScale: native.fontScale }),
    Keyboard: { ...rn.Keyboard, dismiss: native.dismiss },
    View: forwardRef<View, ComponentProps<typeof View>>((props, ref) => {
      if (props.testID) native.layouts.set(props.testID, props.onLayout)
      return <rn.View {...props} ref={ref} onLayout={undefined} />
    }),
    ScrollView: forwardRef<ScrollView, ComponentProps<typeof ScrollView>>((props, ref) => {
      useImperativeHandle(ref, () => ({ scrollTo: native.scrollTo }) as unknown as ScrollView)
      if (!props.horizontal) native.scroll = props
      if (props.testID) native.layouts.set(props.testID, props.onLayout)
      return <rn.ScrollView {...props} onLayout={undefined} />
    }),
    TextInput: forwardRef<TextInput, ComponentProps<typeof TextInput>>((props, ref) => {
      // The read-only placeholder copy is also a TextInput; record the prompt only.
      if (props.testID !== 'compose-placeholder-measure') native.input = props
      if (props.testID) native.layouts.set(props.testID, props.onLayout)
      return <rn.TextInput {...props} ref={ref} onContentSizeChange={undefined} />
    }),
    Text: forwardRef<Text, ComponentProps<typeof Text>>((props, ref) => {
      if (props.testID) native.layouts.set(props.testID, props.onLayout)
      return <rn.Text {...props} ref={ref} onLayout={undefined} />
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
  vi.restoreAllMocks()
  native.fontScale = 1
})

it('keeps the UITextView out of the first sheet layout, then mounts and focuses the saved prompt once', () => {
  const { rerender } = render(
    <ComposeBody {...props} prompt="Saved before cold start" promptReady={false} />,
  )
  expect(screen.queryByRole('textbox', { name: 'Task prompt' })).toBeNull()
  expect(getComputedStyle(screen.getByTestId('compose-prompt-pending')).height).toBe('72px')
  layout('compose-body', 736)
  layout('compose-fields', 132)
  rerender(<ComposeBody {...props} prompt="Saved before cold start" promptReady />)
  const input = screen.getByRole('textbox', { name: 'Task prompt' })
  expect(native.input?.autoFocus).toBe(true)
  expect((input as HTMLTextAreaElement).value).toBe('Saved before cold start')
  expect(screen.queryByTestId('compose-prompt-pending')).toBeNull()
  rerender(<ComposeBody {...props} prompt="Edited after a picker" promptReady keyboardLift={0} />)
  expect(screen.getByRole('textbox', { name: 'Task prompt' })).toBe(input)
})

it('keeps keyboard focus when native fields or toolbar actions are tapped and puts Send in the bottom toolbar', () => {
  render(
    <ComposeBody
      {...props}
      prompt="Keep my focus"
      keyboardLift={336}
      trailingAction={<button type="button">Send</button>}
    />,
  )
  const input = screen.getByRole('textbox', { name: 'Task prompt' })
  input.focus()
  expect(native.scroll?.keyboardShouldPersistTaps).toBe('always')
  const toolbar = screen.getByTestId('compose-toolbar')
  const touch = { identifier: 0, target: toolbar, clientX: 10, clientY: 10, pageX: 10, pageY: 10 }
  fireEvent.touchStart(toolbar, { touches: [touch], changedTouches: [touch] })
  fireEvent.touchEnd(toolbar, { touches: [], changedTouches: [touch] })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  expect(toolbar.contains(screen.getByRole('button', { name: 'Send' }))).toBe(true)
  expect(document.activeElement).toBe(input)
  expect(native.dismiss).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('compose-dismiss-keyboard'))
  expect(native.dismiss).toHaveBeenCalledOnce()
})

it('lets native text grow to ten lines, scrolls at the available height, and shrinks again', () => {
  const { rerender } = render(<ComposeBody {...props} />)
  layout('compose-body', 660)
  layout('compose-toolbar', 60)
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
  rerender(
    <ComposeBody
      {...props}
      prompt={Array.from({ length: 10 }, (_, i) => `Line ${i + 1}`).join('\n')}
      topInset={64}
    />,
  )
  expect(StyleSheet.flatten(native.input?.style)?.maxHeight).toBe(354)
  layout('compose-body', 400)
  expect(StyleSheet.flatten(native.input?.style)?.maxHeight).toBe(94)
  expect(native.input?.scrollEnabled).toBe(true)
  content(56)
  expect(native.input?.scrollEnabled).toBe(false)
  expect(StyleSheet.flatten(native.input?.style)).not.toHaveProperty('height')
})

it('reserves every wrapped placeholder line at large text sizes, then shrinks for typed text', () => {
  native.fontScale = 2.35
  const { rerender } = render(<ComposeBody {...props} />)
  const input = screen.getByRole('textbox', { name: 'Task prompt' })
  layout('compose-body', 400)
  layout('compose-toolbar', 60)
  layout('compose-fields', 210)
  layout('compose-footer', 34)
  // The field's UITextView reports only its empty content. The read-only
  // placeholder copy reports three wrapped lines, at the actual field width/scale.
  content(52)
  layout('compose-placeholder-measure', 168)
  expect(StyleSheet.flatten(native.input?.style)?.minHeight).toBe(168)
  expect(StyleSheet.flatten(native.input?.style)?.maxHeight).toBe(168)
  expect(native.input?.scrollEnabled).toBe(false)
  expect(native.input?.placeholder).toBe('What should change, and why?')
  expect(screen.getByTestId('compose-placeholder-measure').getAttribute('aria-hidden')).toBe('true')

  rerender(<ComposeBody {...props} prompt="A" />)
  expect(screen.getByRole('textbox', { name: 'Task prompt' })).toBe(input)
  expect(screen.queryByTestId('compose-placeholder-measure')).toBeNull()
  expect(StyleSheet.flatten(native.input?.style)?.minHeight).toBe(72)
  expect(StyleSheet.flatten(native.input?.style)).not.toHaveProperty('height')

  rerender(<ComposeBody {...props} />)
  layout('compose-placeholder-measure', 56)
  expect(StyleSheet.flatten(native.input?.style)?.minHeight).toBe(72)
})

it('restores the form below the native sheet header after the keyboard closes, without remounting the prompt', () => {
  const { rerender } = render(
    <ComposeBody {...props} prompt="Keep this draft" keyboardLift={336} topInset={70} />,
  )
  const input = screen.getByRole('textbox', { name: 'Task prompt' })
  expect(native.scroll?.contentInsetAdjustmentBehavior).toBe('never')
  expect(native.scroll?.automaticallyAdjustContentInsets).toBe(false)
  expect(native.scroll?.automaticallyAdjustKeyboardInsets).toBe(false)
  expect(native.scroll?.contentInset?.top).toBe(70)
  expect(native.scroll?.contentOffset?.y).toBe(-70)
  expect(native.scrollTo).not.toHaveBeenCalled()

  const frames: FrameRequestCallback[] = []
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.push(callback)
    return frames.length
  })
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {})
  rerender(<ComposeBody {...props} prompt="Keep this draft" topInset={70} />)
  layout('compose-body', 736)
  layout('compose-toolbar', 86)
  act(() => frames[0]?.(0))
  expect(native.scrollTo).toHaveBeenCalledExactlyOnceWith({ y: -70, animated: false })
  expect(screen.getByRole('textbox', { name: 'Task prompt' })).toBe(input)
  expect((input as HTMLTextAreaElement).value).toBe('Keep this draft')

  rerender(<ComposeBody {...props} prompt="Keep this draft, edited" topInset={70} />)
  expect(native.scrollTo).toHaveBeenCalledTimes(1)
})

it('bounds a twelve-line prompt above the attachment bar and keyboard, with the tip below the input', () => {
  const prompt = Array.from({ length: 12 }, (_, i) => `Line ${i + 1}`).join('\n')
  const { rerender } = render(<ComposeBody {...props} prompt={prompt} keyboardLift={336} />)
  const body = screen.getByTestId('compose-body')
  const viewport = screen.getByTestId('compose-scroll')
  const toolbar = screen.getByTestId('compose-toolbar')
  const tip = screen.getByText(/Something big/)
  expect(getComputedStyle(body).paddingBottom).toBe('336px')
  expect(viewport.parentElement).toBe(body)
  expect(viewport.nextElementSibling).toBe(toolbar)
  expect(StyleSheet.flatten(native.scroll?.style)?.overflow).toBe('hidden')
  expect(getComputedStyle(viewport).minHeight).toBe('0px')
  expect(getComputedStyle(toolbar).flexShrink).toBe('0')
  expect(
    screen
      .getByRole('textbox', { name: 'Task prompt' })
      .parentElement?.nextElementSibling?.contains(tip),
  ).toBe(true)

  // The native viewport excludes both the 60pt toolbar and 336pt keyboard.
  layout('compose-body', 736)
  layout('compose-toolbar', 60)
  expect(StyleSheet.flatten(native.scroll?.style)?.maxHeight).toBe(340)
  layout('compose-fields', 132)
  layout('compose-footer', 34)
  content(276)
  expect(StyleSheet.flatten(native.input?.style)?.maxHeight).toBe(158)
  expect(native.input?.scrollEnabled).toBe(true)
  expect(StyleSheet.flatten(native.input?.style)).not.toHaveProperty('height')

  rerender(<ComposeBody {...props} prompt={prompt} bottomInset={34} />)
  layout('compose-toolbar', 86)
  expect(StyleSheet.flatten(native.scroll?.style)?.maxHeight).toBe(650)
  expect(getComputedStyle(body).paddingBottom).toBe('0px')
  expect(getComputedStyle(toolbar).paddingBottom).toBe('34px')
  expect(native.input?.scrollEnabled).toBe(false)
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
  // A minimum column, so accessibility sizes never break a label mid-word.
  expect(getComputedStyle(screen.getByText('Project')).minWidth).toBe('68px')
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
