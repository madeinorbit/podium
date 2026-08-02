/** Build-failing ownership guard for the sole UI persistence module. */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { DEVICE_LOCAL_UI_KEYS, LAYOUT_KEY_FROM_LEGACY, THEME_UI_KEYS } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { CLIENT_DEVICE_LOCAL_UI_KEYS, uiStateRoute } from './ui-state'

const ROOT = resolve(import.meta.dirname, '../../..')
const UI_STATE_SOURCE = join(import.meta.dirname, 'ui-state.ts')
const PRODUCT_ROOTS = [
  join(ROOT, 'apps/web/src'),
  join(ROOT, 'apps/mobile/src'),
  join(ROOT, 'packages/client-core/src'),
  join(ROOT, 'packages/terminal-client/src'),
]

function sources(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sources(path))
    else if (
      /\.[jt]sx?$/.test(entry.name) &&
      !/\.(?:test|spec|stories)\.[jt]sx?$/.test(entry.name)
    ) {
      out.push(path)
    }
  }
  return out
}

const RAW_STORAGE_LITERAL =
  /(?:globalThis\.|window\.)?localStorage\??\.(?:getItem|setItem|removeItem)\(\s*(['"])(.*?)\1/g

function directOwnedStorage(source: string): string[] {
  const keys: string[] = []
  for (const match of source.matchAll(RAW_STORAGE_LITERAL)) {
    const key = match[2]
    if (!key) continue
    try {
      uiStateRoute(key)
      keys.push(key)
    } catch {
      // Debug flags, replica plumbing and other non-UI storage are not this rule.
    }
  }
  return keys
}

describe('UI persistence ownership lint', () => {
  it('the shared exact vocabulary and client additions are total', () => {
    for (const key of DEVICE_LOCAL_UI_KEYS) expect(uiStateRoute(key).home, key).toBe('device-local')
    for (const key of Object.keys(LAYOUT_KEY_FROM_LEGACY)) {
      expect(uiStateRoute(key).home, key).toBe('per-user-replicated')
    }
    for (const key of CLIENT_DEVICE_LOCAL_UI_KEYS) {
      expect(uiStateRoute(key).home, key).toBe('device-local')
    }
    for (const key of THEME_UI_KEYS) expect(uiStateRoute(key).home, key).toBe('pre-auth-theme')
    expect(uiStateRoute('podium:superfeed:cursor').home).toBe('known-unrouted')
  })

  it('no product file outside ui-state accesses an owned key through raw localStorage', () => {
    const offenders = PRODUCT_ROOTS.flatMap(sources)
      .filter((path) => path !== UI_STATE_SOURCE)
      .flatMap((path) =>
        directOwnedStorage(readFileSync(path, 'utf8')).map(
          (key) => `${relative(ROOT, path)}: ${key}`,
        ),
      )
    expect(offenders).toEqual([])
  })

  it('ui-state has exactly one unnamespaced writer: the typed theme exception', () => {
    const source = readFileSync(UI_STATE_SOURCE, 'utf8')
    const writes = source.match(/(?:globalThis\.|window\.)?localStorage\??\.setItem\([^\n]+/g) ?? []
    expect(writes).toEqual(['globalThis.localStorage?.setItem(key, value)'])
    expect(source).toContain('writePreAuthTheme(key: PreAuthThemeKey, value: string)')
  })

  it('the raw-storage detector rejects a planted owned-key access', () => {
    expect(directOwnedStorage("localStorage.setItem('podium.view', 'issues')")).toEqual([
      'podium.view',
    ])
  })
})
