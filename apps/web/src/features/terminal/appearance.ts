// Deep import on purpose: terminal-view depends only on xterm, while the
// package index drags in the connection/protocol chain this pure module
// (and its tests) don't need.
import {
  DEFAULT_FONT_SIZE,
  DEFAULT_LINE_HEIGHT,
  DEFAULT_THEME,
  type TerminalAppearance,
} from '@podium/terminal-client/terminal-view'
import { FLOW_SLATE } from '@/lib/issueColors'
/**
 * Per-device terminal appearance (font size/family, line height, background)
 * for native agent/shell panels. Persisted as ONE JSON blob in the ui-state
 * collection — device-local like the theme, synced across tabs by ui-state's
 * storage events. Absent fields mean "use the terminal-client default".
 */
export const TERMINAL_APPEARANCE_KEY = 'podium.terminal.appearance'

export interface TerminalAppearanceSettings {
  fontSize?: number
  fontFamily?: string
  lineHeight?: number
  /** CSS color for the terminal background (e.g. '#0a1a3a'). Also applied to
   *  the panel container around the xterm surface so the two never mismatch. */
  background?: string
}

export const FONT_SIZE_MIN = 8
export const FONT_SIZE_MAX = 28
export const LINE_HEIGHT_MIN = 1
export const LINE_HEIGHT_MAX = 2

/** The terminal-client defaults, surfaced for placeholder/reset UI. */
export const TERMINAL_DEFAULTS = {
  fontSize: DEFAULT_FONT_SIZE,
  lineHeight: DEFAULT_LINE_HEIGHT,
  background: DEFAULT_THEME.background as string,
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

/** Parse the stored blob defensively: a malformed or out-of-range value never
 *  breaks the terminal — bad fields fall back to "default" (absent). */
export function parseTerminalAppearance(raw: string | null): TerminalAppearanceSettings {
  if (!raw) return {}
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof obj !== 'object' || obj === null) return {}
  const o = obj as Record<string, unknown>
  const out: TerminalAppearanceSettings = {}
  if (typeof o.fontSize === 'number' && Number.isFinite(o.fontSize)) {
    out.fontSize = clamp(Math.round(o.fontSize), FONT_SIZE_MIN, FONT_SIZE_MAX)
  }
  if (typeof o.fontFamily === 'string' && o.fontFamily.trim() !== '') {
    out.fontFamily = o.fontFamily
  }
  if (typeof o.lineHeight === 'number' && Number.isFinite(o.lineHeight)) {
    out.lineHeight = clamp(o.lineHeight, LINE_HEIGHT_MIN, LINE_HEIGHT_MAX)
  }
  if (typeof o.background === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(o.background.trim())) {
    out.background = o.background.trim()
  }
  return out
}

/**
 * Build the TerminalAppearance handed to the terminal from the stored settings.
 * A custom background merges over the full default palette (cursorAccent tracks
 * the background — it's the "knockout" color drawn inside the bar cursor).
 */
/** Flat sRGB mix of `color` into `base` at pct% — the JS twin of the CSS
 *  `color-mix(in srgb, C pct%, base)` the pane chrome uses, for surfaces that
 *  need a literal colour (the xterm theme can't evaluate color-mix()). */
export function mixHex(color: string, base: string, pct: number): string {
  const ch = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16)
  const mix = (i: number) =>
    Math.round((ch(color, i) * pct + ch(base, i) * (100 - pct)) / 100)
      .toString(16)
      .padStart(2, '0')
  return `#${mix(0)}${mix(1)}${mix(2)}`
}

/**
 * The issue-tinted terminal background (native-pane spec §2.5): the terminal
 * floats on the pane's tinted surface instead of a flat black box. 12% of the
 * issue colour over the terminal base for a coloured issue, 9% slate for the
 * neutral flow. A user-set custom background wins over the tint (Q6) — callers
 * skip this entirely when `settings.background` is set.
 */
export function paneTintedBackground(issueHex: string | undefined): string {
  return mixHex(issueHex ?? FLOW_SLATE, TERMINAL_DEFAULTS.background, issueHex ? 12 : 9)
}

/** Merge a computed background (the pane tint) into an appearance that has no
 *  user-set background of its own. cursorAccent tracks the background — it's
 *  the knockout colour inside the bar cursor. */
export function withBackground(a: TerminalAppearance, background: string): TerminalAppearance {
  return { ...a, theme: { ...DEFAULT_THEME, ...a.theme, background, cursorAccent: background } }
}

export function toTerminalAppearance(s: TerminalAppearanceSettings): TerminalAppearance {
  const a: TerminalAppearance = {}
  if (s.fontSize !== undefined) a.fontSize = s.fontSize
  // Always end the stack in `monospace` — a typo'd or missing font must fall
  // back to A mono face, never the browser's proportional default (which would
  // misalign every TUI frame).
  if (s.fontFamily !== undefined) a.fontFamily = `${s.fontFamily}, monospace`
  if (s.lineHeight !== undefined) a.lineHeight = s.lineHeight
  if (s.background !== undefined) {
    a.theme = { ...DEFAULT_THEME, background: s.background, cursorAccent: s.background }
  }
  return a
}
