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

/**
 * ONLY these product sources may call localStorage / AsyncStorage directly
 * (POD-329). Theme raw access is inside ui-state via read/writePreAuthTheme;
 * everything else is the replica persistence adapter family.
 */
const SANCTIONED_STORAGE_FILES = new Set([
  relative(ROOT, UI_STATE_SOURCE),
  'packages/client-core/src/replica/replica.ts',
  'packages/client-core/src/replica/async-storage.ts',
  'packages/client-core/src/replica/principal-storage.ts',
  'packages/client-core/src/replica/contract.ts',
  'packages/client-core/src/replica/kernel/side-cache.ts',
  'packages/client-core/src/replica/kernel/facade.ts',
  'packages/client-core/src/replica/legacy-snapshot.ts',
  // Platform composition roots that *inject* storage into the replica factory.
  'apps/web/src/lib/webReplica.ts',
  'apps/web/src/lib/desktopReplica.ts',
  'apps/web/src/lib/kernelReplica.ts',
  'apps/web/src/lib/use-kernel-replica.ts',
  'apps/web/src/lib/legacyStoreAttribution.ts',
  'apps/mobile/src/client/MobileClientProvider.tsx',
])

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

  it('the theme is the ONLY pre-auth home — the converse of the forward check', () => {
    // POD-403 asserts every theme key routes to `pre-auth-theme`. That is half
    // the claim, and the half that cannot notice a SECOND key joining the
    // exception. POD-404 makes the theme the *named* exception, so the closed
    // direction is what has to hold: over the whole known vocabulary, exactly
    // the theme keys are pre-auth. A new pre-auth key is a new read that happens
    // before a principal exists, which is the one thing the fail-closed
    // provider cannot police — it does not exist yet when that read happens.
    const everyKnownKey = [
      ...DEVICE_LOCAL_UI_KEYS,
      ...Object.keys(LAYOUT_KEY_FROM_LEGACY),
      ...CLIENT_DEVICE_LOCAL_UI_KEYS,
      ...THEME_UI_KEYS,
      'podium:superfeed:cursor',
      'podium.vreload',
      'podium.outbox.v1',
    ]
    const preAuth = everyKnownKey.filter((key) => uiStateRoute(key).home === 'pre-auth-theme')
    expect([...new Set(preAuth)].sort()).toEqual([...THEME_UI_KEYS].sort())
  })

  it('every known non-UI key is classified (no silent local default)', () => {
    expect(uiStateRoute('podium:superfeed:cursor').home).toBe('known-unrouted')
    expect(uiStateRoute('podium.vreload').home).toBe('known-unrouted')
    expect(uiStateRoute('podium.outbox.v1').home).toBe('known-unrouted')
    expect(uiStateRoute('podium.echoHud').home).toBe('device-local')
    expect(uiStateRoute('podium.switchTrace').home).toBe('device-local')
    expect(uiStateRoute('podium.sounds.ownerWindow').home).toBe('device-local')
    expect(uiStateRoute('podium.htmlmode').home).toBe('per-user-replicated')
    expect(uiStateRoute('podium.mdmode').home).toBe('per-user-replicated')
    expect(uiStateRoute('podium.dock.section.git').home).toBe('per-user-replicated')
  })

  it('ui-state has exactly one unnamespaced READER, and it is the theme', () => {
    // The write side is asserted above. The read side is the one that matters
    // for the pre-auth claim: a read is what can adopt another principal's data,
    // and a raw read is one that happens outside the principal namespace.
    const source = readFileSync(UI_STATE_SOURCE, 'utf8')
    const reads = source.match(/(?:globalThis\.|window\.)?localStorage\??\.getItem\([^\n]+/g) ?? []
    expect(reads).toEqual(['globalThis.localStorage?.getItem(key) ?? null'])
    expect(source).toContain('readPreAuthTheme')
  })

  it('the raw-storage detector rejects a planted owned-key access', () => {
    expect(directOwnedStorage("localStorage.setItem('podium.view', 'issues')")).toEqual([
      'podium.view',
    ])
  })

  it('no product file outside ui-state and the replica adapter touches localStorage/AsyncStorage', () => {
    // Method access only — comments naming localStorage are not a finding.
    const CALL =
      /(?:(?:globalThis|window)\.)?localStorage\s*\??\.(?:getItem|setItem|removeItem|clear)\b|\bAsyncStorage\s*\??\.(?:getItem|setItem|removeItem|multiGet|multiSet|getAllKeys|clear)\b/
    const offenders = PRODUCT_ROOTS.flatMap(sources)
      .map((path) => ({ path, rel: relative(ROOT, path), text: readFileSync(path, 'utf8') }))
      .filter(({ rel, text }) => !SANCTIONED_STORAGE_FILES.has(rel) && CALL.test(text))
      .map(({ rel }) => rel)
      .sort()
    expect(offenders).toEqual([])
  })
})
