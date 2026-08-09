import type { useVoiceInput } from '@podium/terminal-client-react'
import { act, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
    queuedTotal?: number
    turnError?: string | null
  } = { compact: true },
): Promise<{ ta: HTMLTextAreaElement }> {
  const { ChatComposer } = await import('./ChatComposer')
  const taRef = createRef<HTMLTextAreaElement>()
  act(() => {
    root.render(
      <ChatComposer
        taRef={taRef}
        draft={opts.draft ?? ''}
        onDraftChange={() => {}}
        enabled
        placeholder="Ask across all tasks…"
        compact={opts.compact}
        isMobile={false}
        onSend={opts.onSend ?? (() => {})}
        voice={silentVoice}
        attachments={opts.attachments ?? noopAttachments}
        headless={false}
        turnRunning={false}
        canInterrupt={false}
        onInterrupt={() => {}}
        offer={null}
        onOfferAction={async () => {}}
        session={undefined}
        queuedTotal={opts.queuedTotal ?? 0}
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
    expect(dock().className).toContain('border-t')
    expect(dock().className).not.toContain('prompt-dock')
    expect(well().className).toContain('chat-composer-well')
    expect(well().className).not.toContain('focus-within:border-primary')
    expect(well().className).not.toContain('prompt-well')
    expect(ta.className).toContain('max-h-44')
    expect(ta.className).toContain('placeholder:text-text-faint')
    expect(ta.className).not.toContain('prompt-input')
    expect(container.querySelector('.prompt-mark')).toBeNull()
    expect(ta.className).toContain('caret-foreground')
  })

  it('keeps empty send neutral and turns it yellow only when actionable', async () => {
    await mount({ compact: false, draft: '' })
    expect(sendButton().disabled).toBe(true)
    expect(sendButton().className).toContain('bg-secondary')
    expect(sendButton().className).not.toContain('btn-primary-rim')
    expect(sendButton().className).not.toContain('bg-primary')
    expect(sendButton().className).toContain('size-7')
    await mount({ compact: false, draft: 'ship it' })
    expect(sendButton().disabled).toBe(false)
    expect(sendButton().className).toContain('btn-primary-rim')
    expect(sendButton().className).toContain('bg-primary')
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
      queuedTotal: 2,
      turnError: 'Connection refused',
      attachments,
    })
    const notices = container.querySelector('.composer-notices')
    if (!notices) throw new Error('composer notices missing')
    expect(notices?.textContent).toContain('Queued · 2')
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
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, ...init })
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
})
