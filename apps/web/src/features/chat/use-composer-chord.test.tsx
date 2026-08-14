import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useComposerChord } from './use-composer-chord'

// THE FOCUS CHORD IS GLOBAL, WHICH IS WHY IT HAS TO BE POLITE.
//
// One window listener serves every mounted composer, so it sees keystrokes aimed
// at surfaces that have nothing to do with chat. The one that matters is the
// terminal: Ctrl+/ is Ctrl+_ on the wire, readline's undo, and a chord that
// yanks focus out of a shell mid-command loses work.

let host: HTMLDivElement
let root: Root
let focused: string[] = []

function Composer({ name }: { name: string }): null {
  const root_ = document.getElementById(`c-${name}`)
  useComposerChord(root_, () => {
    focused.push(name)
  })
  return null
}

function press(target: Element): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: '/', ctrlKey: true, bubbles: true }))
  })
}

beforeEach(() => {
  focused = []
  host = document.createElement('div')
  host.innerHTML = `
    <div id="c-a"><textarea id="ta-a"></textarea></div>
    <div class="term"><textarea id="term-input"></textarea></div>
    <div id="plain"><button type="button" id="btn">x</button></div>`
  document.body.appendChild(host)
  root = createRoot(document.createElement('div'))
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  host.remove()
})

function mount(): void {
  act(() => {
    root.render(<Composer name="a" />)
  })
}

describe('the composer focus chord', () => {
  it('claims the chord from ordinary chrome', () => {
    mount()
    const btn = host.querySelector('#btn') as HTMLElement
    btn.focus()
    press(btn)
    expect(focused).toEqual(['a'])
  })

  it('leaves the keystroke to a terminal', () => {
    mount()
    const term = host.querySelector('#term-input') as HTMLElement
    term.focus()
    press(term)
    expect(focused).toEqual([])
  })

  it('still answers from inside its own composer', () => {
    mount()
    const own = host.querySelector('#ta-a') as HTMLElement
    own.focus()
    press(own)
    // A field inside a composer root is that composer's own — it wins outright,
    // ahead of the "something else owns the keyboard" refusal above.
    expect(focused).toEqual(['a'])
  })

  it('ignores auto-repeat while the key is held', () => {
    mount()
    const btn = host.querySelector('#btn') as HTMLElement
    btn.focus()
    act(() => {
      btn.dispatchEvent(
        new KeyboardEvent('keydown', { key: '/', ctrlKey: true, repeat: true, bubbles: true }),
      )
    })
    expect(focused).toEqual([])
  })

  it('stops listening once the last composer unmounts', () => {
    mount()
    act(() => {
      root.render(null)
    })
    const btn = host.querySelector('#btn') as HTMLElement
    btn.focus()
    press(btn)
    expect(focused).toEqual([])
  })
})
