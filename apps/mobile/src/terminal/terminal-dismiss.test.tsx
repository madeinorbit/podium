import type { MountSessionOptions } from '@podium/terminal-client/session-mount'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import TerminalDom from './TerminalDom'

const terminal = vi.hoisted(() => ({
  sendInput: vi.fn(),
  requestPaste: vi.fn(),
  focus: vi.fn(),
}))

vi.mock('expo/dom', () => ({ useDOMImperativeHandle: () => {} }))
// Keep the shipped page, keyboard and focus lifecycle together. Only the
// renderer/native bridge are replaced; a DOM textarea models xterm's input.
vi.mock('@podium/terminal-client/session-mount', () => ({
  mountSession: (container: HTMLDivElement, options: MountSessionOptions) => {
    const textarea = document.createElement('textarea')
    textarea.className = 'xterm-helper-textarea'
    textarea.setAttribute('aria-label', 'Terminal input')
    container.append(textarea)
    options.onReady?.()
    return {
      sendInput: terminal.sendInput,
      view: {
        focus: () => {
          terminal.focus()
          textarea.focus()
        },
        requestPaste: terminal.requestPaste,
        onScroll: () => () => {},
        atBottom: () => true,
      },
      setActive: () => {},
      setAppearance: () => {},
      dispose: () => textarea.remove(),
    }
  },
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

const page = (connected = true) => (
  <TerminalDom
    sessionId="keyboard-dismiss"
    active
    connected={connected}
    spawnPending={false}
    onAttachTerminal={async () => {}}
    onDetachTerminal={async () => {}}
    onSendInput={async () => {}}
    onViewportRequest={async () => {}}
    onControlState={async () => {}}
  />
)

async function openConsole() {
  const view = render(page())
  const textarea = await screen.findByRole('textbox', { name: 'Terminal input' })
  await waitFor(() => expect(document.activeElement).toBe(textarea))
  return { ...view, textarea }
}

describe('native console keyboard dismissal', () => {
  it('ends editing from the trailing key without sending input or refocusing on a page update', async () => {
    const { textarea, rerender } = await openConsole()
    fireEvent.change(textarea, { target: { value: 'unfinished prompt' } })
    const hide = screen.getByRole('button', { name: 'Hide Keyboard' })
    expect(hide.parentElement?.lastElementChild).toBe(hide)
    // Pointer and synthesized mouse presses hold focus until activation.
    expect(fireEvent.pointerDown(hide)).toBe(false)
    expect(fireEvent.mouseDown(hide)).toBe(false)
    expect(document.activeElement).toBe(textarea)
    fireEvent.click(hide)
    expect(document.activeElement).not.toBe(textarea)
    expect((textarea as HTMLTextAreaElement).value).toBe('unfinished prompt')
    expect(terminal.sendInput).not.toHaveBeenCalled()
    expect(terminal.requestPaste).not.toHaveBeenCalled()
    const focusCount = terminal.focus.mock.calls.length
    rerender(page())
    expect(document.activeElement).not.toBe(textarea)
    expect(terminal.focus).toHaveBeenCalledTimes(focusCount)

    textarea.focus()
    const hitArea = hide.querySelector('span')
    if (!hitArea) throw new Error('Hide Keyboard has no touch area')
    fireEvent.click(hitArea)
    expect(document.activeElement).not.toBe(textarea)
  })

  it('accepts VoiceOver-style activation without a pointer or mouse event', async () => {
    const { textarea } = await openConsole()
    fireEvent.click(screen.getByRole('button', { name: 'Hide Keyboard' }))
    expect(document.activeElement).not.toBe(textarea)
    expect(terminal.sendInput).not.toHaveBeenCalled()
  })

  it('keeps Submit, Newline and Paste working alongside the dismiss key', async () => {
    const { textarea } = await openConsole()
    fireEvent.click(screen.getByRole('button', { name: /^Submit/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Newline/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Paste/ }))
    expect(terminal.sendInput.mock.calls).toEqual([['\r'], ['\x1b\r']])
    expect(terminal.requestPaste).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(textarea)
  })

  it.each([
    false,
    true,
  ])('places the dismiss key after the optional voice control: %s', async (voice) => {
    if (voice) vi.stubGlobal('SpeechRecognition', class {})
    await openConsole()
    const hide = screen.getByRole('button', { name: 'Hide Keyboard' })
    expect(hide.parentElement?.lastElementChild).toBe(hide)
    expect(hide.parentElement?.classList.contains('has-trailing-action')).toBe(true)
    expect(screen.queryByRole('button', { name: /^Voice input/ }) !== null).toBe(voice)
  })

  it('hides the entire input row while the terminal is not attached', () => {
    render(page(false))
    expect(screen.queryByRole('button', { name: 'Hide Keyboard' })).toBeNull()
  })
})
