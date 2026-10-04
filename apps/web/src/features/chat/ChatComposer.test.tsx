import { createDraftLedger } from '@podium/client-core'
import { createKeyedInputs, type EngineState, type KeyedInputs } from '@podium/client-core/engine'
import { asSessionId } from '@podium/model/browser'
import type { useVoiceInput } from '@podium/terminal-client-react'
import { act, type ComponentProps, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/test-support/model-catalog-mock'
import { useRuntimeDraft } from '@/app/keyed-runtime'
import { PanelVisible } from '@/app/panel-visible'
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

vi.mock('./use-chat-context', () => ({ useChatMentions: () => [] }))
const draftFixture = vi.hoisted(() => ({ inputs: undefined as KeyedInputs | undefined }))
vi.mock('@podium/client-core/react', () => ({ useStoreHandle: () => draftFixture.inputs }))

vi.mock('@/app/store', () => ({
  useReplicaIssues: () => [],
  useRuntimeSelector: () => undefined,
}))

let container: HTMLDivElement
let root: Root
let sizingStyles: HTMLStyleElement

function RuntimeDraftComposer(props: ComponentProps<typeof ChatComposer>) {
  const draft = useRuntimeDraft(asSessionId(props.autoFocusKey))
  return <ChatComposer {...props} draft={draft} />
}

const noopAttachments: UseAttachmentsResult = {
  attachments: [],
  dragOver: false,
  fileInputRef: createRef<HTMLInputElement>(),
  openFilePicker: () => {},
  processFiles: async () => {},
  remove: () => {},
  clear: () => {},
  clearReady: () => {},
  uploading: false,
  ready: () => ({ paths: [], legacyPaths: [], refs: [], tags: [], draftArtifacts: [] }),
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
    visible?: boolean
    draft?: string
    onSend?: () => void
    attachments?: UseAttachmentsResult
    turnError?: string | null
    canInterrupt?: boolean
    onInterrupt?: () => void
    onDraftChange?: (draft: string) => void
    turnRunning?: boolean
    interruptError?: string | null
    transcriptFreshness?: 'checking' | 'rendering' | 'saved' | null
    deliverable?: boolean
    autoFocusKey?: string
    fromRuntime?: boolean
  } = { compact: true },
): Promise<{ ta: HTMLTextAreaElement }> {
  const taRef = createRef<HTMLTextAreaElement>()
  const Composer = opts.fromRuntime ? RuntimeDraftComposer : ChatComposer
  act(() => {
    root.render(
      <PanelVisible visible={opts.visible ?? true}>
        <Composer
          taRef={taRef}
          draft={opts.draft ?? ''}
          onDraftChange={opts.onDraftChange ?? (() => {})}
          deliverable={opts.deliverable ?? true}
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
          transcriptFreshness={opts.transcriptFreshness ?? null}
          offlineAsOf={null}
          autoFocusKey={opts.autoFocusKey ?? 's1'}
          transcriptSettled
        />
      </PanelVisible>,
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
  sizingStyles = document.createElement('style')
  sizingStyles.textContent = 'textarea { line-height: 24px; padding: 0px; }'
  document.head.appendChild(sizingStyles)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  sizingStyles.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe.each([false, true])('draft selection, compact=%s', (compact) => {
  it('keeps deletion through sync, older echoes, focus and session adoption without stale writes', async () => {
    const id = asSessionId('s1'),
      other = asSessionId('s2')
    let state = { drafts: { [id]: 'old message', [other]: 'other current draft' } } as EngineState
    const inputs = createKeyedInputs(() => state)
    draftFixture.inputs = inputs
    const ledger = createDraftLedger()
    ledger.adoptRemote(id, { text: 'old message', rev: 10 })
    const publish = (text: string) => {
      state = { ...state, drafts: { ...state.drafts, [id]: text } }
      inputs.emit(new Set(['drafts']), new Set([id]))
    }
    const onDraftChange = (text: string) => {
      ledger.localEdit(id, text, 1)
      publish(text)
    }
    const options = { compact, fromRuntime: true, onDraftChange }
    try {
      const nativeSet = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      if (!nativeSet) throw new Error('Missing native textarea setter')
      // Install before React captures the prototype setter for its input tracker.
      const writes = vi.spyOn(HTMLTextAreaElement.prototype, 'value', 'set')
      const { ta } = await mount(options)
      expect(ta.value).toBe('old message')
      writes.mockClear()
      act(() => {
        ta.focus()
        ta.setSelectionRange(0, ta.value.length)
        nativeSet.call(ta, '')
        ta.dispatchEvent(new Event('input', { bubbles: true }))
      })
      expect(state.drafts[id]).toBe('')
      expect(ta.value).toBe('')
      writes.mockClear()
      for (const incoming of [
        { text: '', rev: 12 },
        { text: 'old message', rev: 10 },
        { text: 'second old message', rev: 11 },
      ]) {
        act(() => {
          if (ledger.adoptRemote(id, incoming).acceptText) publish(incoming.text)
          ta.blur()
          ta.focus()
        })
        await mount(options)
        expect(ta.value).toBe('')
        expect([ta.selectionStart, ta.selectionEnd]).toEqual([0, 0])
      }
      // Catch even a stale value that was written and replaced before paint.
      expect(writes).not.toHaveBeenCalled()
      await mount({ ...options, autoFocusKey: other })
      expect(ta.value).toBe('other current draft')
      await mount(options)
      expect(ta.value).toBe('')
      expect(state.drafts[id]).toBe('')
    } finally {
      inputs.dispose()
      draftFixture.inputs = undefined
    }
  })

  it('keeps the caret when a draft render follows native mid-text input', async () => {
    const onDraftChange = vi.fn()
    const { ta } = await mount({ compact, draft: 'abcdef', onDraftChange })
    const initialDefault = ta.defaultValue
    const nativeSet = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    const nativeDefault = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'defaultValue',
    )!.set!
    vi.spyOn(HTMLTextAreaElement.prototype, 'defaultValue', 'set').mockImplementation(function (
      this: HTMLTextAreaElement,
      value: string,
    ) {
      const changed = this.defaultValue !== value
      nativeDefault.call(this, value)
      // Reproduce the WebKit order: native input positions the caret, then
      // React's changed default-text write moves it to the end on draft sync.
      if (changed) this.setSelectionRange(this.value.length, this.value.length)
    })
    const valueWrites = vi.spyOn(HTMLTextAreaElement.prototype, 'value', 'set')
    ta.focus()
    ta.setSelectionRange(3, 3)
    act(() => {
      // A browser edit changes value and selection before dispatching input.
      nativeSet.call(ta, 'abcZdef')
      ta.setSelectionRange(4, 4)
      ta.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'Z' }))
    })
    expect(onDraftChange).toHaveBeenLastCalledWith('abcZdef')
    await mount({ compact, draft: 'abcZdef', onDraftChange })
    expect(ta.selectionStart).toBe(4)
    expect(ta.selectionEnd).toBe(4)
    expect(ta.defaultValue).toBe(initialDefault)
    expect(valueWrites).not.toHaveBeenCalled()

    // A second edit replaces a selection rather than appending at the end.
    ta.setSelectionRange(2, 5, 'backward')
    act(() => {
      nativeSet.call(ta, 'abQef')
      ta.setSelectionRange(3, 3)
      ta.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'Q' }))
    })
    await mount({ compact, draft: 'abQef', onDraftChange })
    expect(ta.selectionStart).toBe(3)
    expect(ta.selectionEnd).toBe(3)
    expect(ta.defaultValue).toBe(initialDefault)
    expect(valueWrites).not.toHaveBeenCalled()
  })

  it('preserves a focused selection on external draft sync and clamps it on clear', async () => {
    const { ta } = await mount({ compact, draft: 'abcdef' })
    ta.focus()
    ta.setSelectionRange(2, 5, 'backward')
    await mount({ compact, draft: 'abcdef appended' })
    expect(ta.value).toBe('abcdef appended')
    expect([ta.selectionStart, ta.selectionEnd, ta.selectionDirection]).toEqual([2, 5, 'backward'])
    await mount({ compact, draft: '' })
    expect(ta.value).toBe('')
    expect([ta.selectionStart, ta.selectionEnd]).toEqual([0, 0])
  })

  it('adopts a different session draft without transferring the old selection', async () => {
    const { ta } = await mount({ compact, draft: 'abcdef' })
    ta.focus()
    ta.setSelectionRange(2, 4, 'backward')
    await mount({ compact, draft: 'other session', autoFocusKey: 's2' })
    expect(ta.value).toBe('other session')
    expect([ta.selectionStart, ta.selectionEnd]).toEqual([13, 13])
  })
})

it('sizes the compact field after adopting an external draft and after clearing', async () => {
  const { ta } = await mount({ compact: true, draft: '' })
  Object.defineProperty(ta, 'scrollHeight', {
    configurable: true,
    get: () => (ta.value ? 96 : 24),
  })
  await mount({ compact: true, draft: 'external draft' })
  expect(ta.style.height).toBe('96px')
  await mount({ compact: true, draft: '' })
  expect(ta.style.height).toBe('24px')
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

  // POD-3219. Deliverability gates the SEND, never the box. Before this the
  // textarea carried `disabled={!enabled}`, so a reconnect blip, a not-yet-loaded
  // session row or an ended session refused keystrokes and dropped focus — and
  // the Enter chords relied on that disabled attribute to keep them from firing.
  it('stays writable while a send would not be delivered, and Enter does not send', async () => {
    const onSend = vi.fn()
    const onDraftChange = vi.fn()
    const { ta } = await mount({
      compact: false,
      draft: 'half a thought',
      deliverable: false,
      onSend,
      onDraftChange,
    })
    expect(ta.disabled).toBe(false)
    expect(sendButton().disabled).toBe(true)
    act(() => {
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    act(() => {
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }))
    })
    expect(onSend).not.toHaveBeenCalled()
    // And the same keystroke sends once delivery is possible again.
    await mount({ compact: false, draft: 'half a thought', deliverable: true, onSend })
    act(() => {
      ta.ownerDocument
        .querySelector('textarea')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(onSend).toHaveBeenCalledTimes(1)
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
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(24)
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
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(24)
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
    expect(well().querySelector('[data-testid="attachment-strip"] .pod-mark')).toBeNull()
  })

  it('keeps a stable polite status region through transcript refresh', async () => {
    await mount({ compact: false })
    const status = container.querySelector('[role="status"]')
    expect(status).not.toBeNull()
    expect(status?.textContent).toBe('')

    await mount({ compact: false, transcriptFreshness: 'checking' })
    expect(container.querySelector('[role="status"]')).toBe(status)
    expect(status?.textContent).toContain('Updating transcript')
    expect(status?.textContent).toContain('Showing previous messages')

    await mount({ compact: false, transcriptFreshness: null })
    expect(container.querySelector('[role="status"]')).toBe(status)
    expect(status?.textContent).toContain('Transcript updated')
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
          deliverable
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
          transcriptFreshness={null}
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

describe('ChatComposer height across warm-panel visibility', () => {
  let contentHeight: number

  beforeEach(() => {
    vi.stubGlobal('CSS', Object.create(CSS, { supports: { value: () => false } }))
    contentHeight = 48
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => contentHeight)
  })

  afterEach(() => vi.restoreAllMocks())

  it('preserves a draft height while hidden and measures the same draft on reveal', async () => {
    const { ta } = await mount({ compact: false, draft: 'saved draft' })
    expect(ta.style.height).toBe('48px')
    contentHeight = 0
    await mount({ compact: false, draft: 'updated while hidden', visible: false })
    expect(ta.style.height).toBe('48px')
    contentHeight = 96
    await mount({ compact: false, draft: 'updated while hidden', visible: true })
    expect(ta.style.height).toBe('96px')
    expect(ta.value).toBe('updated while hidden')
  })

  it('measures a populated draft first mounted in a hidden panel when revealed', async () => {
    contentHeight = 0
    const { ta } = await mount({ compact: false, draft: 'saved draft', visible: false })
    expect(ta.style.height).not.toBe('0px')
    expect(ta.className).toContain('min-h-[1lh]')
    contentHeight = 72
    await mount({ compact: false, draft: 'saved draft', visible: true })
    expect(ta.style.height).toBe('72px')
  })

  it('rejects zero measurements even outside a hidden deck panel', async () => {
    const { ta } = await mount({ compact: false, draft: 'a' })
    contentHeight = 0
    await mount({ compact: false, draft: 'ab' })
    expect(ta.style.height).toBe('48px')
    contentHeight = 48
    await mount({ compact: false, draft: 'abc' })
    expect(ta.style.height).toBe('48px')
  })

  it('keeps one line available and caps long drafts while allowing shrink', async () => {
    contentHeight = 1
    const { ta } = await mount({ compact: false, draft: 'short' })
    expect(ta.style.height).toBe('24px')
    contentHeight = 300
    await mount({ compact: false, draft: 'long' })
    expect(ta.style.height).toBe('150px')
    await mount({ compact: false, draft: '' })
    expect(ta.style.height).toBe('24px')
  })
})

describe('native composer sizing', () => {
  it('keeps height measurement off the keystroke path when field-sizing is supported', async () => {
    vi.stubGlobal(
      'CSS',
      Object.create(CSS, {
        supports: {
          value: (property: string, value?: string) =>
            property === 'field-sizing' && value === 'content',
        },
      }),
    )
    const measure = vi.spyOn(Element.prototype, 'scrollHeight', 'get')
    await mount({ compact: false, draft: 'x' })
    measure.mockClear()
    for (let i = 2; i <= 60; i++) await mount({ compact: false, draft: 'x'.repeat(i) })
    expect(measure).not.toHaveBeenCalled()
    expect(container.querySelector('textarea')?.className).toContain('[field-sizing:content]')
  })
})
