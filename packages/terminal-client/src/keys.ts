export type SpecialKey =
  | 'Escape'
  | 'Tab'
  | 'Enter'
  | 'Backspace'
  | 'ArrowUp'
  | 'ArrowDown'
  | 'ArrowRight'
  | 'ArrowLeft'

const SEQUENCES: Record<SpecialKey, string> = {
  Escape: '\x1b',
  Tab: '\t',
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
