import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps, ReactNode } from 'react'
import type { View } from 'react-native'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { COMPOSER_LINE, COMPOSER_MAX_LINES } from './composer-height'

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 20, right: 0, bottom: 34, left: 0 }),
}))
// The composer's surface IS the BlurView, the way the tab bar's capsule is —
// a null stub would erase the component under test rather than its blur.
vi.mock('expo-blur', async () => {
  const { View } = await import('react-native')
  return { BlurView: (props: ComponentProps<typeof View>) => <View {...props} /> }
})
vi.mock('expo-linear-gradient', () => ({
  LinearGradient: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
// `impactAsync` HAS to resolve. PressableScale calls `.catch()` on whatever it
// returns, so a bare `vi.fn()` throws a TypeError inside the press handler —
// before `onPress` runs. Every press in this file was silently swallowed.
vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light' },
  impactAsync: vi.fn(() => Promise.resolve()),
}))
vi.mock('lucide-react-native', () => ({
  ArrowUp: () => null,
  ClipboardPaste: () => null,
  Mic: () => null,
  MicOff: () => null,
  Paperclip: () => null,
  Square: () => null,
}))

const { Composer, composerVoiceStatus } = await import('./Composer')

/**
 * UNMOUNT BETWEEN CASES.
 *
 * This lane runs with `globals: false`, so `@testing-library/react` never
 * registers its own auto-cleanup — every render stayed in `document.body` for
 * the rest of the file. The cases that reach for their input through the
 * returned `container` never noticed; the dictation cases query `screen`, which
 * searches the whole document, and got "found multiple elements by
 * [data-testid=composer-voice]" — a failure about leaked DOM that reads exactly
 * like a failure about the composer rendering two microphones.
 */
afterEach(cleanup)

interface FakeVoiceResult {
  isFinal: boolean
  length: number
  0: { transcript: string }
}

class FakeSpeechRecognition {
  static instances: FakeSpeechRecognition[] = []

  lang = ''
  continuous = false
  interimResults = true
  onstart: (() => void) | null = null
  onresult: ((event: { resultIndex: number; results: FakeVoiceResult[] }) => void) | null = null
  onend: (() => void) | null = null
  onerror: ((event: { error: string }) => void) | null = null
  start = vi.fn()
  stop = vi.fn()

  constructor() {
    FakeSpeechRecognition.instances.push(this)
  }
}

describe('Composer activity caption', () => {
  it('shares the composer bar and disappears without reserving a row', () => {
    const { rerender } = render(
      <Composer placeholder="Message the agent…" onSend={vi.fn()} caption="working" />,
    )

    const bar = screen.getByTestId('composer-bar')
    expect(screen.getByTestId('composer-caption').parentElement).toBe(bar)
    expect(screen.getByTestId('composer-caption').textContent).toBe('working')

    rerender(<Composer placeholder="Message the agent…" onSend={vi.fn()} caption={null} />)
    expect(screen.queryByTestId('composer-caption')).toBeNull()
  })

  it('appends a keyed transcript quote without replacing the current draft', () => {
    const { container, rerender } = render(
      <Composer placeholder="Message the agent…" onSend={vi.fn()} draftInsertion={null} />,
    )
    const input = container.querySelector('textarea')
    expect(input).not.toBeNull()
    if (!input) return
    fireEvent.change(input, { target: { value: 'My note' } })

    rerender(
      <Composer
        placeholder="Message the agent…"
        onSend={vi.fn()}
        draftInsertion={{ id: 1, text: '> quoted\n\n' }}
      />,
    )

    expect(input.value).toBe('My note\n> quoted\n\n')
  })
})

describe('Composer floating dock', () => {
  const dockOf = (container: HTMLElement) =>
    (container.querySelector('[data-testid="composer-bar"]')?.parentElement ??
      null) as HTMLElement | null

  it('pays the bottom safe area when nothing else is below it', () => {
    const { container } = render(<Composer placeholder="Message the agent…" onSend={vi.fn()} />)
    // 34 of home indicator plus the 8 the surface floats above it.
    expect(dockOf(container)?.style.paddingBottom).toBe('42px')
  })

  it('renders a leading slot inside the control row, ahead of send', () => {
    const { container } = render(
      <Composer
        placeholder="Message the agent…"
        onSend={vi.fn()}
        leading={<div data-testid="composer-leading">rail</div>}
      />,
    )
    const slot = container.querySelector('[data-testid="composer-leading"]')
    const send = screen.getByRole('button', { name: 'Send' })
    if (!slot) throw new Error('leading slot not rendered')
    // Inside the capsule now, not slung under it [POD-1677].
    expect(container.querySelector('[data-testid="composer-bar"]')?.contains(slot)).toBe(true)
    expect(slot.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('lets chrome below it replace that inset rather than stacking on it', () => {
    // The tab bar's measured inset already contains the safe area [POD-420];
    // adding the composer's own would float it a home-indicator too high.
    const { container } = render(
      <Composer placeholder="Message the agent…" onSend={vi.fn()} bottomInset={72} />,
    )
    expect(dockOf(container)?.style.paddingBottom).toBe('80px')
  })

  it('drops no glyph in front of the text field', () => {
    const { container } = render(<Composer placeholder="Message the agent…" onSend={vi.fn()} />)
    expect(container.textContent).not.toContain('>')
  })

  it('snaps to measured multiline typing and paste heights without layout frames', () => {
    const { container } = render(<Composer placeholder="Message the agent…" onSend={vi.fn()} />)
    const input = container.querySelector('textarea') as HTMLTextAreaElement
    const field = input.parentElement as HTMLElement
    let contentHeight = COMPOSER_LINE * 3
    Object.defineProperty(input, 'scrollHeight', {
      configurable: true,
      get: () => contentHeight,
    })

    fireEvent.change(input, { target: { value: 'one\ntwo\nthree' } })
    expect(field.style.height).toBe(`${contentHeight}px`)

    contentHeight = COMPOSER_LINE * (COMPOSER_MAX_LINES + 4)
    fireEvent.change(input, {
      target: { value: 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten' },
    })
    expect(field.style.height).toBe(`${COMPOSER_LINE * COMPOSER_MAX_LINES}px`)

    contentHeight = COMPOSER_LINE * 2
    fireEvent.change(input, { target: { value: 'pasted\nlines' } })
    expect(field.style.height).toBe(`${contentHeight}px`)
  })

  it('measures the field without its placeholder, so a wrapping one still rests at one line', () => {
    // A TEXTAREA'S scrollHeight COUNTS ITS PLACEHOLDER (WebKit and Blink both),
    // and "Message — resumes the agent…" wraps onto two lines on a phone. The
    // empty composer used to measure two lines tall and — because the resting
    // height is only reported while the field looks at rest — the transcript
    // underneath never learned the composer's height and its last message
    // scrolled behind the prompt box [POD-1666]. The fake below reproduces the
    // browser: a set placeholder costs a line.
    const { container } = render(
      <Composer placeholder="Message — resumes the agent…" onSend={vi.fn()} />,
    )
    const input = container.querySelector('textarea') as HTMLTextAreaElement
    const field = input.parentElement as HTMLElement
    Object.defineProperty(input, 'scrollHeight', {
      configurable: true,
      get: () => (input.placeholder ? COMPOSER_LINE * 2 : COMPOSER_LINE),
    })

    fireEvent.change(input, { target: { value: 'typed' } })
    fireEvent.change(input, { target: { value: '' } })

    expect(field.style.height).toBe(`${COMPOSER_LINE}px`)
    // Measuring must not COST the placeholder — it is put back in the same
    // effect, before anything paints.
    expect(input.placeholder).toBe('Message — resumes the agent…')
  })
})

/**
 * The rendered size of a control.
 *
 * NOT `element.style` — react-native-web compiles `StyleSheet.create` styles
 * into atomic CSS classes and leaves the inline attribute holding only what
 * Animated writes per frame (`transform`). Reading `.style.width` there answers
 * `''` for every control in the app whether it is 44pt or 4, so the assertion
 * passed nothing and failed once the surrounding leak was closed.
 */
const sizeOf = (element: HTMLElement) => {
  const computed = getComputedStyle(element)
  return { width: computed.width, height: computed.height }
}

describe('Composer web dictation', () => {
  afterEach(() => {
    FakeSpeechRecognition.instances = []
    vi.unstubAllGlobals()
  })

  const supportDictation = () => {
    vi.stubGlobal('SpeechRecognition', FakeSpeechRecognition)
  }

  it('shows platform download status instead of the generic starting label', () => {
    expect(
      composerVoiceStatus({
        starting: true,
        listening: false,
        error: null,
        statusMessage: 'Downloading speech model, 42%',
      }),
    ).toBe('Downloading speech model, 42%')
  })

  it('keeps the control hidden when the browser has no speech API', () => {
    vi.stubGlobal('SpeechRecognition', undefined)
    vi.stubGlobal('webkitSpeechRecognition', undefined)

    render(<Composer placeholder="Message…" onSend={vi.fn()} />)

    expect(screen.queryByTestId('composer-voice')).toBeNull()
  })

  it('uses a 44pt target and appends finalized speech to the live draft', () => {
    supportDictation()
    const { container } = render(<Composer placeholder="Message…" onSend={vi.fn()} />)
    const input = container.querySelector('textarea') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'Typed note' } })

    const microphone = screen.getByTestId('composer-voice')
    expect(sizeOf(microphone)).toEqual({ width: '44px', height: '44px' })
    expect(microphone.getAttribute('aria-label')).toBe('Start dictation')
    const send = screen.getByLabelText('Send')
    expect(sizeOf(send)).toEqual({ width: '44px', height: '44px' })

    fireEvent.click(microphone)
    const recognition = FakeSpeechRecognition.instances[0]
    expect(screen.getByTestId('composer-voice-status').textContent).toBe('Starting dictation…')
    expect(microphone.getAttribute('aria-busy')).toBe('true')

    act(() => recognition.onstart?.())
    expect(screen.getByTestId('composer-voice-status').textContent).toBe('Listening…')
    expect(microphone.getAttribute('aria-label')).toBe('Stop dictation')

    act(() =>
      recognition.onresult?.({
        resultIndex: 0,
        results: [{ isFinal: true, length: 1, 0: { transcript: '  spoken words  ' } }],
      }),
    )
    expect(input.value).toBe('Typed note spoken words')
  })

  it('shows permission failure and lets the operator retry without losing text', () => {
    supportDictation()
    const { container } = render(<Composer placeholder="Message…" onSend={vi.fn()} />)
    const input = container.querySelector('textarea') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'Keep this draft' } })
    const microphone = screen.getByTestId('composer-voice')
    fireEvent.click(microphone)
    const recognition = FakeSpeechRecognition.instances[0]

    act(() => recognition.onerror?.({ error: 'not-allowed' }))

    expect(input.value).toBe('Keep this draft')
    expect(screen.getByTestId('composer-voice-status').textContent).toBe(
      'Microphone access is blocked. Allow it in your browser settings and try again.',
    )
    expect(microphone.getAttribute('aria-label')).toBe('Retry dictation')

    fireEvent.click(microphone)
    expect(FakeSpeechRecognition.instances).toHaveLength(2)
    expect(input.value).toBe('Keep this draft')
  })

  it('invalidates speech before send so a captured late result cannot fill the next draft', () => {
    supportDictation()
    const onSend = vi.fn()
    const { container } = render(<Composer placeholder="Message…" onSend={onSend} />)
    const input = container.querySelector('textarea') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'Typed' } })
    fireEvent.click(screen.getByTestId('composer-voice'))
    const recognition = FakeSpeechRecognition.instances[0]
    act(() => recognition.onstart?.())
    const staleResult = recognition.onresult
    act(() =>
      recognition.onresult?.({
        resultIndex: 0,
        results: [{ isFinal: true, length: 1, 0: { transcript: 'spoken' } }],
      }),
    )
    expect(input.value).toBe('Typed spoken')

    fireEvent.click(screen.getByLabelText('Send'))
    expect(onSend).toHaveBeenCalledWith('Typed spoken', undefined)
    expect(input.value).toBe('')

    act(() =>
      staleResult?.({
        resultIndex: 1,
        results: [
          { isFinal: true, length: 1, 0: { transcript: 'spoken' } },
          { isFinal: true, length: 1, 0: { transcript: 'late' } },
        ],
      }),
    )
    expect(input.value).toBe('')
  })

  it('invalidates speech when the operator clears the field', () => {
    supportDictation()
    const { container } = render(<Composer placeholder="Message…" onSend={vi.fn()} />)
    const input = container.querySelector('textarea') as HTMLTextAreaElement
    fireEvent.click(screen.getByTestId('composer-voice'))
    const recognition = FakeSpeechRecognition.instances[0]
    const staleResult = recognition.onresult
    act(() =>
      recognition.onresult?.({
        resultIndex: 0,
        results: [{ isFinal: false, length: 1, 0: { transcript: 'temporary' } }],
      }),
    )
    expect(input.value).toBe('temporary')

    fireEvent.change(input, { target: { value: '' } })
    expect(recognition.stop).toHaveBeenCalledOnce()
    act(() =>
      staleResult?.({
        resultIndex: 0,
        results: [{ isFinal: true, length: 1, 0: { transcript: 'late final' } }],
      }),
    )
    expect(input.value).toBe('')
  })
})

describe('Composer return key', () => {
  const typeInto = (container: HTMLElement, value: string) => {
    const input = container.querySelector('textarea') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value } })
    return input
  }

  /**
   * The composer asks `(hover: hover) and (pointer: fine)` once, on mount, to
   * tell a desktop browser from a phone. happy-dom answers every media query
   * `true`, which is the DESKTOP reading — so the touch case has to be stated
   * rather than assumed, and both are pinned here.
   */
  const pointer = (fine: boolean) => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: fine,
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }))
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('makes a newline on a plain Enter — a soft keyboard has no Shift to reach for', () => {
    pointer(false)
    const onSend = vi.fn()
    const { container } = render(<Composer placeholder="Message…" onSend={onSend} />)
    const input = typeInto(container, 'half a thought')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('still submits on a plain Enter where a real pointer says a real keyboard', () => {
    pointer(true)
    const onSend = vi.fn()
    const { container } = render(<Composer placeholder="Message…" onSend={onSend} />)
    const input = typeInto(container, 'ship it')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('ship it', undefined)
  })

  it('sends on the Cmd chord even on touch, which is the paired-keyboard escape hatch', () => {
    pointer(false)
    const onSend = vi.fn()
    const { container } = render(<Composer placeholder="Message…" onSend={onSend} />)
    const input = typeInto(container, 'ship it')
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true })
    expect(onSend).toHaveBeenCalledWith('ship it', undefined)
  })

  it('refuses an empty send rather than posting whitespace', () => {
    pointer(true)
    const onSend = vi.fn()
    const { container } = render(<Composer placeholder="Message…" onSend={onSend} />)
    const input = typeInto(container, '   ')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
  })
})
