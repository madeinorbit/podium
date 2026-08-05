import { afterEach, describe, expect, it } from 'vitest'
import { isChatComposerFocusable, isChatInteractable } from './chat-interactable'

const textareas: HTMLTextAreaElement[] = []

function textarea(): HTMLTextAreaElement {
  const el = document.createElement('textarea')
  document.body.append(el)
  Object.defineProperty(el, 'getClientRects', { value: () => [{ width: 100, height: 20 }] })
  textareas.push(el)
  return el
}

function transcript(scrollHeight: number, clientHeight: number): HTMLElement {
  const el = document.createElement('div')
  Object.defineProperties(el, {
    scrollHeight: { configurable: true, value: scrollHeight },
    clientHeight: { configurable: true, value: clientHeight },
  })
  return el
}

afterEach(() => {
  for (const el of textareas.splice(0)) el.remove()
})

describe('chat interactability predicate', () => {
  it('requires a mounted, enabled, focusable composer', () => {
    expect(isChatComposerFocusable(null)).toBe(false)

    const disabled = textarea()
    disabled.disabled = true
    expect(isChatComposerFocusable(disabled)).toBe(false)

    const untabbed = textarea()
    untabbed.tabIndex = -1
    expect(isChatComposerFocusable(untabbed)).toBe(false)

    const live = textarea()
    expect(isChatComposerFocusable(live)).toBe(true)
  })

  it('accepts a composer once the transcript committed, including empty', () => {
    expect(
      isChatInteractable({
        textarea: textarea(),
        transcript: transcript(0, 300),
        transcriptCommitted: true,
      }),
    ).toBe(true)
  })

  it('accepts scrollable transcript content even before the settled flag', () => {
    expect(
      isChatInteractable({
        textarea: textarea(),
        transcript: transcript(700, 300),
        transcriptCommitted: false,
      }),
    ).toBe(true)
  })

  it('does not accept an uncommitted, non-scrollable transcript', () => {
    expect(
      isChatInteractable({
        textarea: textarea(),
        transcript: transcript(300, 300),
        transcriptCommitted: false,
      }),
    ).toBe(false)
  })
})
