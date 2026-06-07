import type { InputEvent } from '../events.js'

export type Mode = 'raw' | 'ink' | 'both'
export type EmitFn = (e: InputEvent) => void
