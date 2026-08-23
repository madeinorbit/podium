import { act, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps, ReactNode } from 'react'
import type { View } from 'react-native'
import { afterEach, describe, expect, it, vi } from 'vitest'

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
vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light' },
  impactAsync: vi.fn(),
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

  it('renders a below slot outside the well', () => {
    const { container } = render(
      <Composer
        placeholder="Message the agent…"
        onSend={vi.fn()}
        below={<div data-testid="composer-below">rail</div>}
      />,
    )
    const bar = container.querySelector('[data-testid="composer-bar"]')
    const below = container.querySelector('[data-testid="composer-below"]')
    expect(bar).not.toBeNull()
    expect(below).not.toBeNull()
    expect(bar?.contains(below)).toBe(false)
    expect(dockOf(container)?.contains(below)).toBe(true)
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
})

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
    expect(microphone.style.width).toBe('44px')
    expect(microphone.style.height).toBe('44px')
    expect(microphone.getAttribute('aria-label')).toBe('Start dictation')
    const send = screen.getByLabelText('Send')
    expect(send.style.width).toBe('44px')
    expect(send.style.height).toBe('44px')

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
