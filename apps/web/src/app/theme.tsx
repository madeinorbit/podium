import { readPreAuthTheme, writePreAuthTheme } from '@podium/client-core'
import { THEME_UI_KEYS } from '@podium/model/browser'
import type { JSX, ReactNode } from 'react'
import { createContext, useContext, useEffect, useState } from 'react'
import { nativeDesktopBridge } from '../lib/nativeDesktop'
import { useStoreSelector } from './store'

export type ThemeMode = 'light' | 'dark' | 'system'
export interface ThemeState {
  mode: ThemeMode
}

/** Resolve whether dark mode should be active, given the stored mode and the
 *  current OS preference. Used by both the provider and the anti-flash script. */
export function resolveDark(mode: ThemeMode, prefersDark: boolean): boolean {
  return mode === 'system' ? prefersDark : mode === 'dark'
}

// The theme mode lives in RAW localStorage on purpose (not only ui-state): it is
// read BEFORE the store exists — by index.html's anti-flash script (pre-React)
// and by ThemeProvider (which wraps StoreProvider) — so the fast path must not
// depend on the replica. ThemeUiStateMirror below write-throughs every change
// into the ui-state collection so the one UI persistence layer stays complete.
// The spelling comes from the model vocabulary — no local restatement.
export const THEME_MODE_KEY = THEME_UI_KEYS[0]

// PWA status-bar / address-bar tint. Must mirror each Podium appearance block's
// --background in index.css; the anti-flash script in index.html duplicates it.
export const THEME_BG: Record<'dark' | 'light', string> = {
  dark: '#16171a',
  light: '#f2f1ed',
}

export function readStoredTheme(): ThemeState {
  const m = readPreAuthTheme(THEME_MODE_KEY)
  return {
    mode: m === 'light' || m === 'dark' || m === 'system' ? m : 'dark',
  }
}

export function applyTheme(state: ThemeState, root: HTMLElement, prefersDark = false): void {
  root.setAttribute('data-theme', 'podium')
  root.classList.toggle('dark', resolveDark(state.mode, prefersDark))
  // Desktop shell: keep the native window appearance on the page's theme. The macOS
  // vibrancy layer behind the transparent command bar renders with the window's
  // NSAppearance (OS-driven), so an explicit light/dark choice must be forwarded or
  // the bar stays in the system's appearance regardless of the page. 'system' hands
  // control back (null) — forcing an appearance would flip prefers-color-scheme and
  // lock system mode to whatever was last forced. The index.html anti-flash script
  // mirrors this call for the pre-React paint.
  void nativeDesktopBridge()?.setTheme?.(state.mode === 'system' ? null : state.mode)
}

interface ThemeContextValue extends ThemeState {
  setMode: (mode: ThemeMode) => void
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
    const meta = document.querySelector('meta[name="theme-color"]')
    const isDark = resolveDark(state.mode, prefersDark)
    const resolvedMode = isDark ? 'dark' : 'light'
    if (meta) meta.setAttribute('content', THEME_BG[resolvedMode])
  }, [state, prefersDark])

  const value: ThemeContextValue = {
    ...state,
    setMode: (mode) => setState((s) => ({ ...s, mode })),
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useTheme(): ThemeContextValue {
  const v = useContext(Ctx)
  if (!v) throw new Error('useTheme outside ThemeProvider')
  return v
}

/**
 * Mirrors the (localStorage-authoritative) theme into the replica's ui-state
 * collection. Mounted INSIDE StoreProvider (theme itself initializes before the
 * store exists — see the key comment above). Render-less.
 */
export function ThemeUiStateMirror(): null {
  const { mode } = useTheme()
  const ui = useStoreSelector((s) => s.uiState)
  useEffect(() => {
    ui.set(THEME_MODE_KEY, mode)
  }, [ui, mode])
  return null
}
