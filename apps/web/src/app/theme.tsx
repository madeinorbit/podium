import { readPreAuthTheme, writePreAuthTheme } from '@podium/client-core'
import { THEME_UI_KEYS } from '@podium/model/browser'
import type { JSX, ReactNode } from 'react'
import { createContext, useContext, useEffect, useState } from 'react'
import { nativeDesktopBridge } from '../lib/nativeDesktop'
import { useStoreSelector } from './store'

export type ThemeMode = 'light' | 'dark' | 'system'

/**
 * WHICH PALETTE THE MODE IS RESOLVED AGAINST.
 *
 * `podium` is the shipped appearance and the default everywhere — Paper and Dark
 * Ink, the two blocks in index.css. `omarchy` is the opt-in profile for the
 * Omarchy desktop (Hyprland + Quickshell, Tokyo Night): one dark palette, square
 * chrome, mono meta type, and a window with no controls of its own because the
 * compositor draws the frame.
 *
 * It is an APPEARANCE, not a preset — nothing outside the token blocks and
 * `omarchy.css` branches on it, so a Linux install that never turns it on is
 * byte-for-byte the shell it was before.
 */
export type ThemeAppearance = 'podium' | 'omarchy'

export interface ThemeState {
  mode: ThemeMode
  appearance: ThemeAppearance
}

/** Resolve whether dark mode should be active, given the stored mode, the
 *  current OS preference and the appearance. Used by both the provider and the
 *  anti-flash script.
 *
 *  Omarchy short-circuits: the design supplies ONE ground and no paper
 *  counterpart, so the profile is dark whatever the mode says. The mode is not
 *  cleared — switching back to Podium must return the operator to the light or
 *  system setting they had, not to whatever Omarchy needed. */
export function resolveDark(
  mode: ThemeMode,
  prefersDark: boolean,
  appearance: ThemeAppearance = 'podium',
): boolean {
  if (appearance === 'omarchy') return true
  return mode === 'system' ? prefersDark : mode === 'dark'
}

// The theme mode lives in RAW localStorage on purpose (not only ui-state): it is
// read BEFORE the store exists — by index.html's anti-flash script (pre-React)
// and by ThemeProvider (which wraps StoreProvider) — so the fast path must not
// depend on the replica. ThemeUiStateMirror below write-throughs every change
// into the ui-state collection so the one UI persistence layer stays complete.
// The spelling comes from the model vocabulary — no local restatement.
export const THEME_MODE_KEY = THEME_UI_KEYS[0]
// The appearance takes the SAME pre-auth path, for the same reason and one more:
// it selects the ground itself, so a first paint that knows the mode but not the
// appearance is exactly the flash the fast path exists to prevent (POD-1531).
export const THEME_APPEARANCE_KEY = THEME_UI_KEYS[1]

// PWA status-bar / address-bar tint. Must mirror each appearance block's
// --background in index.css; the anti-flash script in index.html duplicates it.
// Omarchy is dark-only, so both of its slots carry the one ground — a stale
// `mode: 'light'` from before the switch must not paint stone behind a navy shell.
export const THEME_BG: Record<ThemeAppearance, Record<'dark' | 'light', string>> = {
  podium: {
    dark: '#16171a',
    light: '#f2f1ed',
  },
  omarchy: {
    dark: '#1a1b26',
    light: '#1a1b26',
  },
}

export function readStoredTheme(): ThemeState {
  const m = readPreAuthTheme(THEME_MODE_KEY)
  const a = readPreAuthTheme(THEME_APPEARANCE_KEY)
  return {
    mode: m === 'light' || m === 'dark' || m === 'system' ? m : 'dark',
    appearance: a === 'omarchy' ? 'omarchy' : 'podium',
  }
}

export function applyTheme(state: ThemeState, root: HTMLElement, prefersDark = false): void {
  root.setAttribute('data-theme', state.appearance)
  const isDark = resolveDark(state.mode, prefersDark, state.appearance)
  root.classList.toggle('dark', isDark)
  // Desktop shell: keep the native window appearance on the page's theme. The macOS
  // vibrancy layer behind the transparent command bar renders with the window's
  // NSAppearance (OS-driven), so an explicit light/dark choice must be forwarded or
  // the bar stays in the system's appearance regardless of the page. 'system' hands
  // control back (null) — forcing an appearance would flip prefers-color-scheme and
  // lock system mode to whatever was last forced. Omarchy is never 'system': the
  // profile IS an explicit dark choice, and letting the OS answer would leave the
  // frame light around a navy window. The index.html anti-flash script mirrors
  // this call for the pre-React paint.
  const forwarded: 'light' | 'dark' | null =
    state.appearance === 'omarchy' ? 'dark' : state.mode === 'system' ? null : state.mode
  void nativeDesktopBridge()?.setTheme?.(forwarded)
}

interface ThemeContextValue extends ThemeState {
  setMode: (mode: ThemeMode) => void
  setAppearance: (appearance: ThemeAppearance) => void
}
const Ctx = createContext<ThemeContextValue | null>(null)

function getPrefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
}

export function ThemeProvider({ children }: { children: ReactNode }): JSX.Element {
  const [state, setState] = useState<ThemeState>(readStoredTheme)
  const [prefersDark, setPrefersDark] = useState<boolean>(getPrefersDark)

  // Subscribe to OS color-scheme changes; only matters when mode === 'system'.
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (e: MediaQueryListEvent) => setPrefersDark(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  useEffect(() => {
    applyTheme(state, document.documentElement, prefersDark)
    writePreAuthTheme(THEME_MODE_KEY, state.mode)
    writePreAuthTheme(THEME_APPEARANCE_KEY, state.appearance)
    const meta = document.querySelector('meta[name="theme-color"]')
    const isDark = resolveDark(state.mode, prefersDark, state.appearance)
    const resolvedMode = isDark ? 'dark' : 'light'
    if (meta) meta.setAttribute('content', THEME_BG[state.appearance][resolvedMode])
  }, [state, prefersDark])

  const value: ThemeContextValue = {
    ...state,
    setMode: (mode) => setState((s) => ({ ...s, mode })),
    setAppearance: (appearance) => setState((s) => ({ ...s, appearance })),
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useTheme(): ThemeContextValue {
  const v = useContext(Ctx)
  if (!v) throw new Error('useTheme outside ThemeProvider')
  return v
}

/**
 * The appearance alone, and the ONE theme read that does not throw off-provider.
 *
 * Chrome components ask this to choose a glyph family or a mark asset, and they
 * are rendered in three places `ThemeProvider` does not wrap: unit tests that
 * mount one row on its own, the pre-store boot screens, and the error page.
 * Throwing there would turn a cosmetic question into a crash, so the answer with
 * no provider is the default appearance — which is also the correct one, since
 * nothing has read a stored profile yet.
 */
export function useThemeAppearance(): ThemeAppearance {
  return useContext(Ctx)?.appearance ?? 'podium'
}

/**
 * Mirrors the (localStorage-authoritative) theme into the replica's ui-state
 * collection. Mounted INSIDE StoreProvider (theme itself initializes before the
 * store exists — see the key comment above). Render-less.
 */
export function ThemeUiStateMirror(): null {
  const { mode, appearance } = useTheme()
  const ui = useStoreSelector((s) => s.uiState)
  useEffect(() => {
    ui.set(THEME_MODE_KEY, mode)
    ui.set(THEME_APPEARANCE_KEY, appearance)
  }, [ui, mode, appearance])
  return null
}
