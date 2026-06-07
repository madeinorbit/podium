export type SpecialKey =
  | 'Escape'
  | 'Tab'
  | 'ShiftTab'
  | 'Enter'
  | 'Backspace'
  | 'ArrowUp'
  | 'ArrowDown'
  | 'ArrowRight'
  | 'ArrowLeft'

const SEQUENCES: Record<SpecialKey, string> = {
  Escape: '\x1b',
  Tab: '\t',
  // Back-tab (CSI Z) — reverse completion in shells, mode cycling in Claude Code.
  ShiftTab: '\x1b[Z',
  Enter: '\r',
  Backspace: '\x7f',
  ArrowUp: '\x1b[A',
  ArrowDown: '\x1b[B',
  ArrowRight: '\x1b[C',
  ArrowLeft: '\x1b[D',
}

export function keySequence(key: SpecialKey): string {
  return SEQUENCES[key]
}

/** Ctrl+<letter> → the corresponding C0 control code (e.g. 'c' → 0x03). */
export function ctrlSequence(letter: string): string {
  const lower = letter.toLowerCase()
  const code = lower.charCodeAt(0)
  if (lower.length !== 1 || code < 97 || code > 122) {
    throw new Error(`ctrlSequence expects a single a–z letter, got: ${letter}`)
  }
  return String.fromCharCode(code - 96)
}

/**
 * Ctrl applied to a single character, or null where Ctrl has no effect. Unlike
 * `ctrlSequence` this never throws — it is the safe variant for arming a Ctrl
 * modifier against arbitrary keyboard input. Only ASCII letters map (the common
 * Ctrl+letter case: Ctrl-A, Ctrl-E, Ctrl-W, …); anything else returns null.
 */
export function ctrlByte(char: string): string | null {
  if (char.length !== 1) return null
  const code = char.toLowerCase().charCodeAt(0)
  if (code < 97 || code > 122) return null
  return String.fromCharCode(code - 96)
}
