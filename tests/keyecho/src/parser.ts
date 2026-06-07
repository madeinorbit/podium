import type { InputEvent, KeyEvent, UnknownEvent } from './events.js'

let SEQ = 0
function nextSeq(): number {
  SEQ += 1
  return SEQ
}

function key(bytes: number[], partial: Omit<KeyEvent, 'kind' | 'source' | 'seq' | 'bytes'>): KeyEvent {
  return { kind: 'key', source: 'raw', seq: nextSeq(), bytes, ...partial }
}

function unknown(bytes: number[]): UnknownEvent {
  return { kind: 'unknown', source: 'raw', seq: nextSeq(), bytes, label: `Unknown(${bytes.length}b)` }
}

const CTRL_LETTER = (b: number) => String.fromCharCode(b + 0x60) // 0x01 -> 'a'

function decodeControl(b: number, bytes: number[]): KeyEvent {
  switch (b) {
    case 0x0d:
      return key(bytes, { name: 'enter', ctrl: false, meta: false, shift: false, label: 'Enter' })
    case 0x09:
      return key(bytes, { name: 'tab', ctrl: false, meta: false, shift: false, label: 'Tab' })
    case 0x08:
    case 0x7f:
      return key(bytes, { name: 'backspace', ctrl: false, meta: false, shift: false, label: 'Backspace' })
    case 0x00:
      return key(bytes, { name: 'space', ctrl: true, meta: false, shift: false, label: 'Ctrl+Space' })
    default: {
      const letter = CTRL_LETTER(b) // 0x01..0x1a => a..z (covers 0x0a 'j')
      return key(bytes, {
        name: letter,
        ctrl: true,
        meta: false,
        shift: false,
        label: `Ctrl+${letter.toUpperCase()}`,
      })
    }
  }
}

/**
 * Decode one chunk of raw stdin into events. Pure: returns leftover bytes (`rest`)
 * for any sequence that is incomplete at the end of `buf`, so the caller can prepend
 * `rest` to the next chunk. Never throws.
 */
export function decodeInput(buf: Buffer): { events: InputEvent[]; rest: Buffer } {
  const events: InputEvent[] = []
  let i = 0
  while (i < buf.length) {
    const b = buf[i] as number
    if (b === 0x1b) {
      // ESC sequences land here in later tasks; for now treat lone ESC as unknown.
      events.push(unknown([b]))
      i += 1
      continue
    }
    if (b < 0x20 || b === 0x7f) {
      events.push(decodeControl(b, [b]))
      i += 1
      continue
    }
    // Printable handled in a later task; emit unknown for now.
    events.push(unknown([b]))
    i += 1
  }
  return { events, rest: Buffer.alloc(0) }
}
