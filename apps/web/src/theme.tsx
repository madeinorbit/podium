import type { JSX, ReactNode } from 'react'
import { createContext, useContext, useEffect, useState } from 'react'

export type ThemePreset = 'shadcn' | 'podium'
export type ThemeMode = 'light' | 'dark' | 'system'
export interface ThemeState {
  preset: ThemePreset
  mode: ThemeMode
}

/** Resolve whether dark mode should be active, given the stored mode and the
 *  current OS preference. Used by both the provider and the anti-flash script. */
export function resolveDark(mode: ThemeMode, prefersDark: boolean): boolean {
  return mode === 'system' ? prefersDark : mode === 'dark'
}

export const THEME_PRESET_KEY = 'podium.theme.preset'
export const THEME_MODE_KEY = 'podium.theme.mode'

// PWA status-bar / address-bar tint per theme. Must mirror each preset/mode block's
// --background in index.css; the anti-flash script in index.html duplicates these.
export const THEME_BG: Record<string, string> = {
  'podium-dark': '#0e0e12',
  'podium-light': '#f7f7f9',
  'shadcn-dark': '#09090b',
  'shadcn-light': '#ffffff',
}

function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function lsSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // best-effort; storage can throw in private mode
  }
}

export function readStoredTheme(): ThemeState {
  const p = lsGet(THEME_PRESET_KEY)
  const m = lsGet(THEME_MODE_KEY)
  return {
    preset: p === 'shadcn' || p === 'podium' ? p : 'podium',
    mode: m === 'light' || m === 'dark' || m === 'system' ? m : 'dark',
  }
}

export function applyTheme(state: ThemeState, root: HTMLElement, prefersDark = false): void {
  if (state.preset === 'podium') root.setAttribute('data-theme', 'podium')
  else root.removeAttribute('data-theme')
  root.classList.toggle('dark', resolveDark(state.mode, prefersDark))
}

interface ThemeContextValue extends ThemeState {
  setPreset: (preset: ThemePreset) => void
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
    lsSet(THEME_PRESET_KEY, state.preset)
    lsSet(THEME_MODE_KEY, state.mode)
    const meta = document.querySelector('meta[name="theme-color"]')
    const isDark = resolveDark(state.mode, prefersDark)
    const resolvedMode = isDark ? 'dark' : 'light'
    const bg = THEME_BG[`${state.preset}-${resolvedMode}`]
    if (meta && bg) meta.setAttribute('content', bg)
  }, [state, prefersDark])

  const value: ThemeContextValue = {
    ...state,
    setPreset: (preset) => setState((s) => ({ ...s, preset })),
    setMode: (mode) => setState((s) => ({ ...s, mode })),
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useTheme(): ThemeContextValue {
  const v = useContext(Ctx)
  if (!v) throw new Error('useTheme outside ThemeProvider')
  return v
}
