export type CaptureSource = 'raw' | 'ink'

interface BaseEvent {
  source: CaptureSource
  seq: number
  bytes: number[]
}

export interface KeyEvent extends BaseEvent {
  kind: 'key'
  name: string // 'a', 'enter', 'tab', 'escape', 'backspace', 'up', 'f1', ...
  ctrl: boolean
  meta: boolean // alt / option
  shift: boolean
  label: string
}

export type MouseAction = 'press' | 'release' | 'move' | 'wheel'
export type MouseButton = 'left' | 'middle' | 'right' | 'wheelUp' | 'wheelDown' | 'none'

export interface MouseEvent extends BaseEvent {
  kind: 'mouse'
  action: MouseAction
  button: MouseButton
  x: number
  y: number
  ctrl: boolean
  meta: boolean
  shift: boolean
  label: string
}

export interface PasteEvent extends BaseEvent {
  kind: 'paste'
  text: string
  label: string
}

export interface UnknownEvent extends BaseEvent {
  kind: 'unknown'
  label: string
}

export type InputEvent = KeyEvent | MouseEvent | PasteEvent | UnknownEvent

export function toHex(bytes: number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ')
}

export function toCaret(bytes: number[]): string {
  return bytes
    .map((b) => {
      if (b === 0x7f) return '^?'
      if (b < 0x20) return `^${String.fromCharCode(b + 0x40)}`
      return String.fromCharCode(b)
    })
    .join('')
}

export function formatEvent(e: InputEvent): string {
  const hex = toHex(e.bytes).padEnd(14)
  const caret = toCaret(e.bytes).padEnd(8)
  return `[${e.source}] ${hex} ${caret} ${e.label}`
}
