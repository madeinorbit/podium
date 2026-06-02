import type { SessionConnection } from './connection'
import { ctrlSequence, keySequence, type SpecialKey } from './keys'

const KEYS: SpecialKey[] = [
  'Escape',
  'Tab',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Enter',
]

export function mountKeyToolbar(el: HTMLElement, conn: SessionConnection): () => void {
  const doc = el.ownerDocument
  const buttons: HTMLButtonElement[] = []

  const addButton = (label: string, send: () => void) => {
    const b = doc.createElement('button')
    b.type = 'button'
    b.textContent = label
    b.dataset.key = label
    b.addEventListener('click', send)
    el.appendChild(b)
    buttons.push(b)
  }

  for (const k of KEYS) addButton(k, () => conn.sendInput(keySequence(k)))
  addButton('Ctrl-C', () => conn.sendInput(ctrlSequence('c')))

  return () => {
    for (const b of buttons) b.remove()
  }
}
