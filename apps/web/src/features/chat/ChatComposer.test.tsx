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
  opts: { compact: boolean; draft?: string; onSend?: () => void } = { compact: true },
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
        attachments={noopAttachments}
        headless={false}
        turnRunning={false}
        canInterrupt={false}
        onInterrupt={() => {}}
        offer={null}
        onOfferAction={async () => {}}
        session={undefined}
        queuedTotal={0}
        turnError={null}
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
const well = () => container.querySelector('.prompt-well, .border-border-strong') as HTMLElement
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
    // The CLI mark lights with the field through `.prompt-well:focus-within`.
    expect(container.querySelector('.prompt-mark')).not.toBeNull()
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

describe('ChatComposer, non-compact (the main chat) is untouched', () => {
  it('keeps its own dock, field and height cap, and takes none of the primitive', async () => {
    const { ta } = await mount({ compact: false })
    expect(dock().className).toContain('border-t')
    expect(dock().className).not.toContain('prompt-dock')
    expect(well().className).toContain('border-border-strong')
    expect(well().className).toContain('focus-within:border-primary')
    expect(well().className).not.toContain('prompt-well')
    expect(ta.className).toContain('max-h-44')
    expect(ta.className).toContain('placeholder:text-text-faint')
    expect(ta.className).not.toContain('prompt-input')
    expect(container.querySelector('.prompt-mark')).toBeNull()
  })

  it('keeps the filled primary send button at every draft state', async () => {
    await mount({ compact: false, draft: '' })
    expect(sendButton().className).toContain('bg-primary')
    expect(sendButton().className).toContain('size-7')
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
