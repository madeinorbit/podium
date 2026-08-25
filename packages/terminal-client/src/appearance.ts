import type { ITheme } from '@xterm/xterm'

/** The user-tunable rendering options shared with shells before xterm loads. */
export interface TerminalAppearance {
  fontSize?: number
  fontFamily?: string
  /** Multiplier on the cell height (xterm semantics, >= 1). */
  lineHeight?: number
  theme?: ITheme
}

export const DEFAULT_FONT_SIZE = 15
export const DEFAULT_LINE_HEIGHT = 1.15

/** Palette aligned with the web app's terminal surface tokens. */
export const DEFAULT_THEME: ITheme = {
  background: '#0e0e12',
  foreground: '#d7d7e0',
  cursor: '#D97757',
  cursorAccent: '#0e0e12',
  selectionBackground: 'rgba(245, 158, 11, 0.30)',
  selectionForeground: '#f3f3f8',
  black: '#16161c',
  brightBlack: '#3a3a46',
  red: '#f87171',
  brightRed: '#fca5a5',
  green: '#34d399',
  brightGreen: '#6ee7b7',
  yellow: '#fbbf24',
  brightYellow: '#fcd34d',
  blue: '#60a5fa',
  brightBlue: '#93c5fd',
  magenta: '#c084fc',
  brightMagenta: '#d8b4fe',
  cyan: '#22d3ee',
  brightCyan: '#67e8f9',
  white: '#d7d7e0',
  brightWhite: '#f3f3f8',
}
