import type {
  InputEvent,
  KeyEvent,
  MouseButton,
  MouseEvent as MouseEv,
  PasteEvent as PasteEv,
  UnknownEvent,
} from './events.js'

let SEQ = 0
function nextSeq(): number {
  SEQ += 1
  return SEQ
}

const cap = (s: string): string => (s.length <= 1 ? s : s.charAt(0).toUpperCase() + s.slice(1))

function key(bytes: number[], partial: Omit<KeyEvent, 'kind' | 'source' | 'seq' | 'bytes'>): KeyEvent {
  return { kind: 'key', source: 'raw', seq: nextSeq(), bytes, ...partial }
}

function mouseEvent(bytes: number[], partial: Omit<MouseEv, 'kind' | 'source' | 'seq' | 'bytes'>): MouseEv {
  return { kind: 'mouse', source: 'raw', seq: nextSeq(), bytes, ...partial }
}

function pasteEvent(bytes: number[], text: string): PasteEv {
  return { kind: 'paste', source: 'raw', seq: nextSeq(), bytes, text, label: `Paste (${text.length} chars)` }
}

function unknown(bytes: number[]): UnknownEvent {
  return { kind: 'unknown', source: 'raw', seq: nextSeq(), bytes, label: `Unknown(${bytes.length}b)` }
}

const CTRL_LETTER = (b: number): string => String.fromCharCode(b + 0x60) // 0x01 -> 'a'

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

const CSI_FINAL: Record<string, { name: string; label: string }> = {
  A: { name: 'up', label: 'Up' },
  B: { name: 'down', label: 'Down' },
  C: { name: 'right', label: 'Right' },
  D: { name: 'left', label: 'Left' },
  H: { name: 'home', label: 'Home' },
  F: { name: 'end', label: 'End' },
  Z: { name: 'tab', label: 'Shift+Tab' }, // shift handled below
}

const CSI_TILDE: Record<number, { name: string; label: string }> = {
  1: { name: 'home', label: 'Home' },
  2: { name: 'insert', label: 'Insert' },
  3: { name: 'delete', label: 'Delete' },
  4: { name: 'end', label: 'End' },
  5: { name: 'pageup', label: 'PageUp' },
  6: { name: 'pagedown', label: 'PageDown' },
  7: { name: 'home', label: 'Home' },
  8: { name: 'end', label: 'End' },
}

const SS3_FINAL: Record<string, { name: string; label: string }> = {
  P: { name: 'f1', label: 'F1' },
  Q: { name: 'f2', label: 'F2' },
  R: { name: 'f3', label: 'F3' },
  S: { name: 'f4', label: 'F4' },
  H: { name: 'home', label: 'Home' },
  F: { name: 'end', label: 'End' },
}

const NAMED_KEY_BY_CODE: Record<number, string> = { 13: 'enter', 9: 'tab', 27: 'escape' }

interface Mods {
  shift: boolean
  meta: boolean
  ctrl: boolean
}

// xterm modifier param is a (mod-1) bitfield: 1=none 2=Shift 3=Alt 5=Ctrl 6=Ctrl+Shift ...
function decodeModifier(param: number | undefined): Mods {
  if (!param || param < 2) return { shift: false, meta: false, ctrl: false }
  const bits = param - 1
  return { shift: (bits & 1) !== 0, meta: (bits & 2) !== 0, ctrl: (bits & 4) !== 0 }
}

function withMods(base: string, m: Mods): string {
  const parts: string[] = []
  if (m.ctrl) parts.push('Ctrl')
  if (m.meta) parts.push('Alt')
  if (m.shift) parts.push('Shift')
  parts.push(base)
  return parts.join('+')
}

function hasMods(m: Mods): boolean {
  return m.shift || m.meta || m.ctrl
}

const PASTE_START = Buffer.from('\x1b[200~', 'latin1')
const PASTE_END = Buffer.from('\x1b[201~', 'latin1')

/** Parse a generic CSI sequence starting at buf[start] === ESC, buf[start+1] === '['. */
function parseCsi(buf: Buffer, start: number): { event: InputEvent; len: number } | 'incomplete' {
  let j = start + 2
  const params: number[] = []
  let cur = ''
  while (j < buf.length) {
    const c = buf[j] as number
    if (c >= 0x30 && c <= 0x39) {
      cur += String.fromCharCode(c)
      j += 1
      continue
    }
    if (c === 0x3b) {
      params.push(cur === '' ? 0 : Number(cur))
      cur = ''
      j += 1
      continue
    }
    if (cur !== '') params.push(Number(cur))
    const finalChar = String.fromCharCode(c)
    const bytes = Array.from(buf.subarray(start, j + 1))

    if (finalChar === '~') {
      const code = params[0] ?? 0
      if (code === 27) {
        // modifyOtherKeys: ESC [ 27 ; <mod> ; <char> ~
        const mod = decodeModifier(params[1])
        const charCode = params[2] ?? 0
        const name = NAMED_KEY_BY_CODE[charCode] ?? String.fromCharCode(charCode)
        return { event: key(bytes, { name, ...mod, label: withMods(cap(name), mod) }), len: bytes.length }
      }
      const tilde = CSI_TILDE[code]
      const mod = decodeModifier(params[1])
      if (tilde) {
        const label = hasMods(mod) ? withMods(tilde.label, mod) : tilde.label
        return { event: key(bytes, { name: tilde.name, ...mod, label }), len: bytes.length }
      }
      return { event: unknown(bytes), len: bytes.length }
    }

    const known = CSI_FINAL[finalChar]
    if (known) {
      if (finalChar === 'Z') {
        return {
          event: key(bytes, { name: 'tab', shift: true, meta: false, ctrl: false, label: 'Shift+Tab' }),
          len: bytes.length,
        }
      }
      const mod = decodeModifier(params[1])
      const label = hasMods(mod) ? withMods(known.label, mod) : known.label
      return { event: key(bytes, { name: known.name, ...mod, label }), len: bytes.length }
    }
    return { event: unknown(bytes), len: bytes.length }
  }
  return 'incomplete'
}

function decodeSgrButton(cb: number): { action: 'press' | 'move' | 'wheel'; button: MouseButton } {
  const isWheel = (cb & 0x40) !== 0
  const isMotion = (cb & 0x20) !== 0
  const low = cb & 0x03
  if (isWheel) return { action: 'wheel', button: low === 0 ? 'wheelUp' : 'wheelDown' }
  const button: MouseButton = low === 0 ? 'left' : low === 1 ? 'middle' : low === 2 ? 'right' : 'none'
  if (isMotion) return { action: 'move', button }
  return { action: 'press', button }
}

/** Parse ESC [ < ... (M|m) starting at the ESC index. */
function parseSgrMouse(buf: Buffer, start: number): { event: MouseEv; len: number } | 'incomplete' {
  let j = start + 3 // past ESC [ <
  let s = ''
  while (j < buf.length) {
    const c = buf[j] as number
    if ((c >= 0x30 && c <= 0x39) || c === 0x3b) {
      s += String.fromCharCode(c)
      j += 1
      continue
    }
    if (c === 0x4d /* M */ || c === 0x6d /* m */) {
      const parts = s.split(';').map((n) => Number(n))
      const cb = parts[0] ?? 0
      const x = parts[1] ?? 0
      const y = parts[2] ?? 0
      const bytes = Array.from(buf.subarray(start, j + 1))
      const d = decodeSgrButton(cb)
      const isRelease = c === 0x6d
      const action = d.action === 'press' && isRelease ? 'release' : d.action
      const shift = (cb & 0x04) !== 0
      const meta = (cb & 0x08) !== 0
      const ctrl = (cb & 0x10) !== 0
      const label = `Mouse ${d.button} ${action} @ (${x},${y})`
      return {
        event: mouseEvent(bytes, { action, button: d.button, x, y, ctrl, meta, shift, label }),
        len: bytes.length,
      }
    }
    return 'incomplete'
  }
  return 'incomplete'
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
      const next = buf[i + 1]

      if (next === 0x5b /* [ */) {
        // bracketed paste: ESC [ 200 ~ ... ESC [ 201 ~
        if (buf.subarray(i, i + PASTE_START.length).equals(PASTE_START)) {
          const endRel = buf.subarray(i).indexOf(PASTE_END)
          if (endRel === -1) return { events, rest: buf.subarray(i) }
          const payloadStart = i + PASTE_START.length
          const payloadEnd = i + endRel
          const text = buf.subarray(payloadStart, payloadEnd).toString('utf8')
          const bytes = Array.from(buf.subarray(i, payloadEnd + PASTE_END.length))
          events.push(pasteEvent(bytes, text))
          i = payloadEnd + PASTE_END.length
          continue
        }
        // SGR mouse: ESC [ < ...
        if (buf[i + 2] === 0x3c) {
          const m = parseSgrMouse(buf, i)
          if (m === 'incomplete') return { events, rest: buf.subarray(i) }
          events.push(m.event)
          i += m.len
          continue
        }
        const res = parseCsi(buf, i)
        if (res === 'incomplete') return { events, rest: buf.subarray(i) }
        events.push(res.event)
        i += res.len
        continue
      }

      if (next === 0x4f /* O */) {
        const c = buf[i + 2]
        if (c === undefined) return { events, rest: buf.subarray(i) }
        const ss3 = SS3_FINAL[String.fromCharCode(c)]
        const bytes = [b, next, c]
        events.push(
          ss3
            ? key(bytes, { name: ss3.name, ctrl: false, meta: false, shift: false, label: ss3.label })
            : unknown(bytes),
        )
        i += 3
        continue
      }

      if (next === undefined || next === 0x1b) {
        events.push(key([b], { name: 'escape', ctrl: false, meta: false, shift: false, label: 'Escape' }))
        i += 1
        continue
      }

      // Meta/Alt: ESC + one key. Decode that key, set meta, prefix label with Alt+.
      const inner = decodeInput(buf.subarray(i + 1, i + 2))
      const ie = inner.events[0]
      const innerBytes = [b, buf[i + 1] as number]
      if (ie && ie.kind === 'key') {
        events.push(
          key(innerBytes, { name: ie.name, ctrl: ie.ctrl, meta: true, shift: ie.shift, label: `Alt+${cap(ie.name)}` }),
        )
      } else {
        events.push(unknown(innerBytes))
      }
      i += 2
      continue
    }

    if (b < 0x20 || b === 0x7f) {
      events.push(decodeControl(b, [b]))
      i += 1
      continue
    }

    // Printable run: collect bytes >= 0x20 (not DEL, not ESC) and decode as UTF-8.
    let j = i
    while (j < buf.length && (buf[j] as number) >= 0x20 && (buf[j] as number) !== 0x7f && (buf[j] as number) !== 0x1b) {
      j += 1
    }
    const text = buf.subarray(i, j).toString('utf8')
    for (const ch of text) {
      events.push(key([...Buffer.from(ch, 'utf8')], { name: ch, ctrl: false, meta: false, shift: false, label: ch }))
    }
    i = j
  }
  return { events, rest: Buffer.alloc(0) }
}
