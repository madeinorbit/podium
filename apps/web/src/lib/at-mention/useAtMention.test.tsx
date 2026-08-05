/**
 * THE KEYBOARD CONTRACT (POD-412).
 *
 * The picker lives inside a composer whose `onKeyDown` already carries Enter,
 * Shift+Enter and an IME composition, and the whole reason `onKeyDown` returns a
 * boolean is that it must take those keys ONLY when it is genuinely open. That
 * claim is worth a test with a real textarea and real events rather than a
 * reading of the code, so this mounts a miniature composer shaped exactly like
 * the two real ones.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { JSX } from 'react'
import { useRef, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AtMentionMenu } from './AtMentionMenu'
import type { AtOption } from './at-mention'
import { useAtMenu, useAtTrigger } from './useAtMention'

const OPTIONS: AtOption[] = [
  {
    kind: 'issue',
    id: 'a',
    label: 'POD-412',
    detail: 'Composer context picker',
    insert: 'POD-412',
  },
  { kind: 'issue', id: 'b', label: 'POD-376', detail: 'Chatview redesign', insert: 'POD-376' },
  { kind: 'file', id: 'c', label: 'ChatComposer.tsx', detail: 'apps/web', insert: '`x.tsx`' },
]

function Composer({ onSend }: { onSend: () => void }): JSX.Element {
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  const [draft, setDraft] = useState('')
  const trigger = useAtTrigger({ taRef })
  const mention = useAtMenu({
    trigger,
    taRef,
    value: draft,
    onChange: setDraft,
    options: trigger.query === null ? [] : OPTIONS,
  })
  return (
    <div>
      <AtMentionMenu mention={mention} />
      <textarea
        ref={taRef}
        aria-label="draft"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value)
          trigger.sync()
        }}
        onSelect={trigger.sync}
        onKeyDown={(e) => {
          if (mention.onKeyDown(e)) return
          if (e.key === 'Enter' && (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229)) {
            return
          }
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            onSend()
          }
        }}
      />
    </div>
  )
}

/** Type into the textarea the way a person does: the DOM value and caret change,
 *  then React hears about it. */
function type(ta: HTMLTextAreaElement, value: string, caret = value.length): void {
  fireEvent.change(ta, { target: { value } })
  ta.selectionStart = caret
  ta.selectionEnd = caret
  fireEvent.select(ta)
}

const setup = () => {
  const onSend = vi.fn()
  render(<Composer onSend={onSend} />)
  return { onSend, ta: screen.getByLabelText('draft') as HTMLTextAreaElement }
}

const menu = () => screen.queryByTestId('at-mention-menu')

// This config registers no global setup file, so RTL's auto-cleanup never runs
// and every render would stack up in one document.
afterEach(cleanup)

describe('the @ menu in a composer', () => {
  it('is absent until an @ is typed, and opens on it', () => {
    const { ta } = setup()
    expect(menu()).toBeNull()
    type(ta, 'hello ')
    expect(menu()).toBeNull()
    type(ta, 'hello @')
    expect(menu()).not.toBeNull()
    expect(screen.getAllByRole('option')).toHaveLength(3)
  })

  it('inserts the highlighted row on Enter, and does NOT send', () => {
    const { ta, onSend } = setup()
    type(ta, 'see @')
    fireEvent.keyDown(ta, { key: 'ArrowDown' })
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(ta.value).toBe('see POD-376 ')
    expect(onSend).not.toHaveBeenCalled()
    expect(menu()).toBeNull()
  })

  it('wraps the highlight around both ends', () => {
    const { ta } = setup()
    type(ta, '@')
    fireEvent.keyDown(ta, { key: 'ArrowUp' })
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(ta.value).toBe('`x.tsx` ')
  })

  it('sends on Enter when no menu is open — the composer keeps its key', () => {
    const { ta, onSend } = setup()
    type(ta, 'just a message')
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledTimes(1)
  })

  it('leaves Shift+Enter alone even with the menu open — a newline stays reachable', () => {
    const { ta, onSend } = setup()
    type(ta, '@')
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true })
    expect(onSend).not.toHaveBeenCalled()
    // Not consumed by the menu either: nothing was inserted.
    expect(ta.value).toBe('@')
  })

  it('leaves ⌘+Enter alone too — send stays reachable with the menu open', () => {
    const { ta, onSend } = setup()
    type(ta, '@')
    fireEvent.keyDown(ta, { key: 'Enter', metaKey: true })
    // Nothing inserted, and the composer below got its key.
    expect(ta.value).toBe('@')
    expect(onSend).toHaveBeenCalledTimes(1)
  })

  it('yields every key to an in-flight IME composition', () => {
    const { ta, onSend } = setup()
    type(ta, '@')
    // The candidate list owns the arrows and Enter while composing.
    fireEvent.keyDown(ta, { key: 'Enter', isComposing: true })
    expect(ta.value).toBe('@')
    expect(onSend).not.toHaveBeenCalled()
    // …including the browsers that report only the legacy keyCode.
    fireEvent.keyDown(ta, { key: 'Enter', keyCode: 229 })
    expect(ta.value).toBe('@')
    expect(onSend).not.toHaveBeenCalled()
  })

  it('stays dismissed after Escape while the caret is still in the mention', () => {
    const { ta } = setup()
    type(ta, '@po')
    expect(menu()).not.toBeNull()
    fireEvent.keyDown(ta, { key: 'Escape' })
    expect(menu()).toBeNull()
    // The old menu re-opened on the very next keystroke, which meant Escape
    // could not actually dismiss anything.
    type(ta, '@pod')
    expect(menu()).toBeNull()
    // A NEW mention elsewhere is unaffected.
    type(ta, '@pod and @')
    expect(menu()).not.toBeNull()
  })

  it('closes when the mention is finished with a space', () => {
    const { ta } = setup()
    type(ta, '@pod')
    expect(menu()).not.toBeNull()
    type(ta, '@pod ')
    expect(menu()).toBeNull()
  })

  it('inserts at the caret and leaves the rest of the draft alone', () => {
    const { ta } = setup()
    type(ta, 'about @ tomorrow', 7)
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(ta.value).toBe('about POD-412 tomorrow')
    expect(ta.selectionStart).toBe('about POD-412'.length)
  })

  it('inserts on a click, and the click does not blur the composer first', () => {
    const { ta } = setup()
    type(ta, '@')
    const row = screen.getAllByRole('option')[1] as HTMLElement
    expect(fireEvent.mouseDown(row)).toBe(false) // default prevented: focus stays
    fireEvent.click(row)
    expect(ta.value).toBe('POD-376 ')
  })
})
