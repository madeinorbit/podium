import { useInput } from 'ink'
import type { KeyEvent } from '../events.js'
import type { EmitFn } from './types.js'

let inkSeq = 0

/** Build a KeyEvent from Ink's (input, key) callback. */
export function inkKeyToEvent(input: string, key: Record<string, boolean>): KeyEvent {
  inkSeq += 1
  const name =
    Object.keys(key).find((k) => key[k] && k !== 'ctrl' && k !== 'meta' && k !== 'shift') ??
    input ??
    ''
  const ctrl = !!key.ctrl
  const meta = !!key.meta
  const shift = !!key.shift
  const base = name.length <= 1 ? name : name.charAt(0).toUpperCase() + name.slice(1)
  const parts: string[] = []
  if (ctrl) parts.push('Ctrl')
  if (meta) parts.push('Alt')
  if (shift) parts.push('Shift')
  parts.push(base || '(none)')
  return {
    kind: 'key',
    source: 'ink',
    seq: inkSeq,
    bytes: [...Buffer.from(input ?? '', 'utf8')],
    name: name || input || '',
    ctrl,
    meta,
    shift,
    label: parts.join('+'),
  }
}

/** Hook: capture via Ink's own input pipeline when `active`. */
export function useInkSource(emit: EmitFn, active: boolean): void {
  useInput(
    (input, key) => {
      emit(inkKeyToEvent(input, key as unknown as Record<string, boolean>))
    },
    { isActive: active },
  )
}
