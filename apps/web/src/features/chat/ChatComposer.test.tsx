import type { useVoiceInput } from '@podium/terminal-client-react'
import { act, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatComposer } from './ChatComposer'
import type { UseAttachmentsResult } from './use-attachments'

// ---------------------------------------------------------------------------
// THE COMPOSER'S TWO SKINS (POD-516).
//
// `compact` is the Superagent — one mount site, `SuperagentView` → `ChatView`
// → `ChatComposer` — and under it the box wears the shared prompt primitive so
// that the in-thread composer and the empty-thread one in `SuperagentView` are
// the same object. Everything else in the app renders the main chat composer,
// which must come out of this change untouched.
//
// So the assertions come in pairs: what compact gained, and what non-compact
// still has and did NOT gain. The keyboard contract is asserted over both,
// because it is shared and must not fork.
// ---------------------------------------------------------------------------

vi.mock('@/app/store', () => ({
  useReplicaIssues: () => [],
  useStoreSelector: () => undefined,
}))

let container: HTMLDivElement
let root: Root

const noopAttachments: UseAttachmentsResult = {
  attachments: [],
  dragOver: false,
  fileInputRef: createRef<HTMLInputElement>(),
  openFilePicker: () => {},
  processFiles: async () => {},
  remove: () => {},
  clear: () => {},
  uploading: false,
  ready: () => ({ paths: [], tags: [] }),
  dropHandlers: { onDragOver: () => {}, onDragLeave: () => {}, onDrop: () => {} },
  onPaste: () => {},
  onFileInputChange: () => {},
}

const silentVoice = {
  supported: false,
  listening: false,
  toggle: () => {},
} as unknown as ReturnType<typeof useVoiceInput>

async function mount(
  opts: {
    compact: boolean
    draft?: string
    onSend?: () => void
    attachments?: UseAttachmentsResult
    turnError?: string | null
    canInterrupt?: boolean
    onInterrupt?: () => void
    onDraftChange?: (draft: string) => void
    turnRunning?: boolean
    interruptError?: string | null
  } = { compact: true },
): Promise<{ ta: HTMLTextAreaElement }> {
  const taRef = createRef<HTMLTextAreaElement>()
  act(() => {
    root.render(
      <ChatComposer
        taRef={taRef}
        draft={opts.draft ?? ''}
        onDraftChange={opts.onDraftChange ?? (() => {})}
        enabled
        placeholder="Ask across all tasks…"
        compact={opts.compact}
        isMobile={false}
        onSend={opts.onSend ?? (() => {})}
        voice={silentVoice}
        attachments={opts.attachments ?? noopAttachments}
        turnRunning={opts.turnRunning ?? false}
        canInterrupt={opts.canInterrupt ?? false}
        onInterrupt={opts.onInterrupt ?? (() => {})}
        interruptError={opts.interruptError ?? null}
        offer={null}
        onOfferAction={async () => {}}
        onOfferDismiss={async () => {}}
        session={undefined}
        turnError={opts.turnError ?? null}
        offlineAsOf={null}
        autoFocusKey="s1"
        transcriptSettled
      />,
    )
  })
  return { ta: container.querySelector('textarea') as HTMLTextAreaElement }
}

/** The composer's outermost element — the dock. */
const dock = () => container.firstElementChild as HTMLElement
/** The field surface: the only element carrying `relative` under the dock. */
const well = () => container.querySelector('.prompt-well, .chat-composer-well') as HTMLElement
const sendButton = () =>
  container.querySelector('button[title="Send (Enter)"]') as HTMLButtonElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('ChatComposer, compact (the Superagent box)', () => {
  it('renders no meta strip under the box', async () => {
    await mount({ compact: true })
    // The human asked for "auto delegate on and the other info under it" gone:
    // it stated a mode the box does not have and two shortcuts that are not
    // the Superagent's.
    expect(container.textContent).not.toContain('auto-delegate')
    expect(container.textContent).not.toContain('shift+tab')
    expect(container.textContent).not.toContain('? for shortcuts')
  })

  it('wears the shared prompt primitive', async () => {
    const { ta } = await mount({ compact: true })
    expect(dock().className).toContain('prompt-dock')
    expect(well().className).toContain('prompt-well')
    expect(ta.className).toContain('prompt-input')
    expect(container.querySelector('.prompt-mark')).toBeNull()
    expect(ta.className).toContain('caret-foreground')
  })

  it('drops the old ground, the yellow focus border and the hard height cap', async () => {
    const { ta } = await mount({ compact: true })
    expect(dock().className).not.toContain('border-t')
    expect(well().className).not.toContain('focus-within:border-primary')
    // The height is driven in px by usePromptAutoGrow; a CSS clamp would fight
    // the animated value.
    expect(ta.className).not.toContain('max-h-44')
    expect(ta.className).not.toContain('overflow-y-auto')
  })

  it('reads the placeholder in Dim ink, not Faint', async () => {
    const { ta } = await mount({ compact: true })
    expect(ta.className).toContain('placeholder:text-text-dim')
    expect(ta.className).not.toContain('placeholder:text-text-faint')
  })

  it('fills the send affordance yellow only once there is something to send', async () => {
    await mount({ compact: true, draft: '' })
    expect(sendButton().className).not.toContain('bg-primary')
    expect(sendButton().className).toContain('text-text-dim')
    await mount({ compact: true, draft: 'ship it' })
    expect(sendButton().className).toContain('bg-primary')
  })
})

describe('ChatComposer, non-compact (the main chat)', () => {
  it('keeps its own dock and height cap while adopting the neutral issue seam', async () => {
    const { ta } = await mount({ compact: false })
    // No top rule (POD-725): the composer sits on the stage sheet's own card
    // tone and the field's well is the only boundary the design draws. A border
    // here cut the document off from the thing it is a reply to.
    expect(dock().className).not.toContain('border-t')
    expect(dock().className).not.toContain('prompt-dock')
    expect(dock().className).toContain('chat-composer-dock')
    expect(well().className).toContain('chat-composer-well')
    expect(well().className).not.toContain('focus-within:border-primary')
    expect(well().className).not.toContain('prompt-well')
    expect(ta.className).toContain('max-h-[150px]')
    expect(ta.className).toContain('placeholder:text-text-faint')
    expect(ta.className).not.toContain('prompt-input')
    expect(container.querySelector('.prompt-mark')).toBeNull()
    expect(ta.className).toContain('caret-foreground')
  })

  it('keeps empty send neutral and turns it yellow only when actionable', async () => {
    await mount({ compact: false, draft: '' })
    expect(sendButton().disabled).toBe(true)
    // POD-993 round 2: the resting send takes the chip ground the rest of the
    // cluster hovers to, not the louder --secondary it had.
    expect(sendButton().className).toContain('bg-chip')
    expect(sendButton().className).not.toContain('btn-primary-rim')
    expect(sendButton().className).not.toContain('bg-primary')
    expect(sendButton().className).toContain('size-7')
    await mount({ compact: false, draft: 'ship it' })
    expect(sendButton().disabled).toBe(false)
    expect(sendButton().className).toContain('btn-primary-rim')
    expect(sendButton().className).toContain('bg-primary')
  })

  // AUTO-GROW COSTS A LAYOUT, AND IT USED TO COST THREE (POD-2045).
  //
  // The box measures itself on every keystroke, and measuring means a forced
  // synchronous layout of the whole document — which on a long transcript is
  // the most expensive thing that happens between pressing a key and seeing the
  // character. It was paying that price twice per keystroke plus a full
  // computed-style parse, on the ~95% of keystrokes where the height does not
  // change at all. What is left is the one measurement the feature IS.
  it('measures its line box once, not once per keystroke', async () => {
    const spy = vi.spyOn(window, 'getComputedStyle')
    try {
      const { ta } = await mount({ compact: false, draft: 'a' })
      const onTextarea = (): number => spy.mock.calls.filter((c) => c[0] === ta).length
      const afterFirst = onTextarea()

      await mount({ compact: false, draft: 'ab' })
      await mount({ compact: false, draft: 'abc' })
      await mount({ compact: false, draft: 'abcd' })

      expect(onTextarea()).toBe(afterFirst)
      expect(afterFirst).toBeLessThanOrEqual(1)
    } finally {
      spy.mockRestore()
    }
  })

  it('does not force a reflow when the height did not change', async () => {
    const { ta } = await mount({ compact: false, draft: 'a' })
    let reflows = 0
    // The transition-pinning read. It exists to give the height animation a
    // start value to interpolate FROM, so it is only owed when the height is
    // actually about to move.
    Object.defineProperty(ta, 'offsetHeight', {
      get: () => {
        reflows++
        return 0
      },
      configurable: true,
    })

    await mount({ compact: false, draft: 'ab' })
    await mount({ compact: false, draft: 'abc' })

    expect(reflows).toBe(0)
  })

  it('anchors notices above the field and attachments inside it', async () => {
    const attachments = {
      ...noopAttachments,
      attachments: [
        {
          id: 'a1',
          name: 'frame.png',
          size: 14 * 1024,
          previewUrl: 'blob:frame',
          state: 'ready' as const,
        },
        {
          id: 'a2',
          name: 'uploading.png',
          size: 2 * 1024,
          previewUrl: 'blob:uploading',
          state: 'uploading' as const,
        },
      ],
    }
    await mount({
      compact: false,
      turnError: 'Connection refused',
      attachments,
    })
    const notices = container.querySelector('.composer-notices')
    if (!notices) throw new Error('composer notices missing')
    expect(notices?.textContent).toContain('Not sent')
    expect(notices.compareDocumentPosition(well()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(well().querySelector('[data-testid="attachment-strip"]')?.textContent).toContain(
      'frame.png· 14 KB',
    )
    expect(well().querySelector('[data-testid="attachment-strip"]')?.textContent).toContain(
      'uploading.png· 2 KBUploading',
    )
    expect(well().querySelector('[data-testid="attachment-strip"] .spb')).toBeNull()
  })
})

// The @-menu's first refusal, the IME guard and Enter/Shift+Enter are ONE
// handler shared by both skins. Table-driven so a future divergence fails here.
describe.each([
  { name: 'compact', compact: true },
  { name: 'non-compact', compact: false },
])('ChatComposer keyboard contract ($name)', ({ compact }) => {
  const press = (ta: HTMLTextAreaElement, init: KeyboardEventInit & { keyCode?: number }) => {
    // `cancelable: true` because a real keydown is, and because without it
    // `preventDefault()` is a no-op and `defaultPrevented` can never read true —
    // which is how the double-Escape case landed asserting something the harness
    // made unobservable. Set on every press rather than just that one: an event
    // the browser would let a handler cancel should be cancelable here too.
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
      ...init,
    })
    if (init.keyCode !== undefined) {
      Object.defineProperty(event, 'keyCode', { value: init.keyCode })
    }
    act(() => {
      ta.dispatchEvent(event)
    })
    return event
  }

  it('sends on Enter', async () => {
    const onSend = vi.fn()
    const { ta } = await mount({ compact, draft: 'hi', onSend })
    press(ta, {})
    expect(onSend).toHaveBeenCalledTimes(1)
  })

  it('does not send on Shift+Enter', async () => {
    const onSend = vi.fn()
    const { ta } = await mount({ compact, draft: 'hi', onSend })
    press(ta, { shiftKey: true })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('lets an IME candidate confirm itself, by isComposing and by keyCode 229', async () => {
    const onSend = vi.fn()
    const { ta } = await mount({ compact, draft: 'hi', onSend })
    press(ta, { isComposing: true })
    press(ta, { keyCode: 229 })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('interrupts on a quick double Escape from an empty prompt', async () => {
    const onInterrupt = vi.fn()
    const { ta } = await mount({ compact, draft: '', canInterrupt: true, onInterrupt })
    const first = press(ta, { key: 'Escape' })
    expect(first.defaultPrevented).toBe(true)
    expect(onInterrupt).not.toHaveBeenCalled()
    press(ta, { key: 'Escape' })
    expect(onInterrupt).toHaveBeenCalledTimes(1)
  })

  it('leaves Escape alone when there is text or no active turn', async () => {
    const onInterrupt = vi.fn()
    const withText = await mount({ compact, draft: 'keep me', canInterrupt: true, onInterrupt })
    expect(press(withText.ta, { key: 'Escape' }).defaultPrevented).toBe(false)
    expect(press(withText.ta, { key: 'Escape' }).defaultPrevented).toBe(false)
    await mount({ compact, draft: '', canInterrupt: false, onInterrupt })
    const idle = container.querySelector('textarea') as HTMLTextAreaElement
    expect(press(idle, { key: 'Escape' }).defaultPrevented).toBe(false)
    expect(press(idle, { key: 'Escape' }).defaultPrevented).toBe(false)
    expect(onInterrupt).not.toHaveBeenCalled()
  })

  // POD-1214: the stop control used to be headless-only, which left the chord
  // above as the sole way to stop a native session from chat.
  it('shows the stop control on a NATIVE running turn, not just a headless one', async () => {
    const onInterrupt = vi.fn()
    await mount({ compact, turnRunning: true, canInterrupt: true, onInterrupt })
    const stop = container.querySelector('[data-testid="composer-stop"]') as HTMLButtonElement
    expect(stop).not.toBeNull()
    act(() => stop.click())
    expect(onInterrupt).toHaveBeenCalledTimes(1)
  })

  it('hides the stop control when nothing is running', async () => {
    await mount({ compact, turnRunning: false, canInterrupt: true })
    expect(container.querySelector('[data-testid="composer-stop"]')).toBeNull()
  })

  // A stop that did not stop anything must say so — and must not borrow
  // sending's "Not sent", which would describe the wrong failure.
  it('reports a refused stop as its own notice', async () => {
    await mount({
      compact,
      interruptError: 'Codex only takes an interrupt while it is working',
      turnError: null,
    })
    const notice = container.querySelector('[data-notice="interrupt-error"]') as HTMLElement
    expect(notice).not.toBeNull()
    expect(notice.textContent).toContain('Not stopped')
    expect(notice.textContent).toContain('only takes an interrupt while it is working')
    expect(container.querySelector('[data-notice="error"]')).toBeNull()
  })
})

describe('ChatComposer backend rail', () => {
  it('lists every connector even before a harness is frozen', () => {
    const taRef = createRef<HTMLTextAreaElement>()
    act(() => {
      root.render(
        <ChatComposer
          taRef={taRef}
          draft=""
          onDraftChange={() => {}}
          enabled
          placeholder="Ask across all tasks…"
          compact
          isMobile={false}
          onSend={() => {}}
          voice={silentVoice}
          attachments={noopAttachments}
          turnRunning={false}
          canInterrupt={false}
          onInterrupt={() => {}}
          offer={null}
          onOfferAction={async () => {}}
          onOfferDismiss={async () => {}}
          session={undefined}
          turnError={null}
          offlineAsOf={null}
          autoFocusKey="s1"
          transcriptSettled
          backend={{ agentKind: undefined, model: 'auto', effort: 'auto' }}
          onBackendModelChange={() => {}}
          onBackendEffortChange={() => {}}
        />,
      )
    })
    const rail = container.querySelector('[data-testid="composer-backend"]')
    expect(rail).not.toBeNull()
    const model = container.querySelector('[aria-label="Model"]') as HTMLButtonElement
    expect(model.textContent).toContain('Auto')
  })
})
