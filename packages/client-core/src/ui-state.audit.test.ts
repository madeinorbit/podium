/** Build-failing ownership guard for the sole UI persistence module. */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import {
  DEVICE_LOCAL_UI_KEYS,
  LAYOUT_EXACT_KEYS,
  LAYOUT_KEY_FROM_LEGACY,
  LAYOUT_KEY_PREFIXES,
  layoutKeyFromLegacy,
  THEME_UI_KEYS,
} from '@podium/model'
import { describe, expect, it } from 'vitest'
import {
  CLIENT_DEVICE_LOCAL_UI_KEYS,
  createRoutedUiState,
  DOCK_SECTION_KEY_PREFIX,
  KNOWN_NON_UI_ROUTES,
  SIDEBAR_COLLAPSED_KEY,
  SUPERAGENT_MODE_KEY,
  UI_STATE_KEYS,
  uiStateRoute,
} from './ui-state'

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
    // POD-1380 routed the last unrouted key: it is per-user state with its own
    // family and command, not a layout key and not device-local.
    expect(uiStateRoute('podium:superfeed:cursor').home).toBe('per-user-command')
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
    expect(uiStateRoute('podium:superfeed:cursor').home).toBe('per-user-command')
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

  it('NO key is left unrouted that names an issue as its home', () => {
    // A `known-unrouted` row is a promissory note: it says an issue owns the
    // decision. POD-1380 was the last one, so the remaining two must be the
    // mechanism exceptions (a pre-store sessionStorage guard and the replica's
    // own legacy blob) and nothing else. A new deferred key has to be a
    // deliberate edit here rather than something that accumulates quietly.
    const unrouted = Object.entries(KNOWN_NON_UI_ROUTES)
      .filter(([, route]) => route.home === 'known-unrouted')
      .map(([key]) => key)
      .sort()
    expect(unrouted).toEqual(['podium.outbox.v1', 'podium.vreload'])
  })

  it('the command-homed key is REFUSED by the ui-state router, not written locally', () => {
    // The trap this home exists to close: falling back to local storage would
    // give this device a private copy of a value that follows the user, and it
    // would look like it worked.
    const local = {
      get: () => null,
      set: () => {
        throw new Error('local write must never be reached for a command-homed key')
      },
      subscribe: () => () => {},
    }
    const replicated = {
      get: () => undefined,
      set: () => {},
      clear: () => {},
      hydrate: async () => {},
      subscribe: () => () => {},
    }
    const routed = createRoutedUiState({ local: local as never, replicated })
    expect(() => routed.get('podium:superfeed:cursor')).toThrow(/own command family/)
    expect(() => routed.set('podium:superfeed:cursor', '{"id":1}')).toThrow(/own command family/)
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

// ---------------------------------------------------------------------------
// Routing TOTALITY over the shared layout vocabulary (POD-1534)
// ---------------------------------------------------------------------------

/**
 * Every legacy storage spelling this module has ever persisted, composed from
 * the declarations rather than restated. `UI_STATE_KEYS` carries the sole
 * spelling of the panelMode keys (panel-mode-duality / POD-329), so composing
 * from it keeps those literals out of this file too.
 */
const LEGACY_UI_STATE_VOCABULARY: readonly string[] = [
  ...Object.values(UI_STATE_KEYS),
  ...Object.keys(LAYOUT_KEY_FROM_LEGACY),
  SUPERAGENT_MODE_KEY,
  SIDEBAR_COLLAPSED_KEY,
  ...DEVICE_LOCAL_UI_KEYS,
  ...CLIENT_DEVICE_LOCAL_UI_KEYS,
]

/** The legacy PREFIXES under which dynamic section keys are spelled on disk. */
const LEGACY_SECTION_PREFIXES: readonly string[] = ['podium:sidebar:', DOCK_SECTION_KEY_PREFIX]

/**
 * The canonical layout keys that are actually REACHABLE: a legacy spelling the
 * router classifies `per-user-replicated` maps onto them. Derived by ROUTING,
 * never from `LAYOUT_EXACT_KEYS` — a set built from the list it is meant to
 * check is the tautology this audit exists to replace.
 */
function reachableLayoutKeys(vocabulary: readonly string[]): ReadonlySet<string> {
  const reached = new Set<string>()
  for (const legacy of vocabulary) {
    if (uiStateRoute(legacy).home !== 'per-user-replicated') continue
    const layoutKey = layoutKeyFromLegacy(legacy)
    if (layoutKey !== null) reached.add(layoutKey)
  }
  return reached
}

/**
 * The finding this audit reports: a persisted key admitted into the shared
 * vocabulary with NO declared home. Exposed as a function over the key list so
 * the check itself can be shown to refuse a planted key.
 */
function unhomedLayoutKeys(
  exactKeys: readonly string[],
  vocabulary: readonly string[] = LEGACY_UI_STATE_VOCABULARY,
): string[] {
  const reached = reachableLayoutKeys(vocabulary)
  return exactKeys.filter((key) => !reached.has(key)).sort()
}

describe('UI-state routing totality over the shared layout vocabulary', () => {
  it('every exact layout key has a declared home — and every home names a declared key', () => {
    // POD-427 item 3: adding a key here with no home must FAIL, not wait for the
    // first runtime read. `uiStateRoute` is default-closed and throws on such a
    // key, which is correct and kept — but nothing reached it before this.
    //
    // The two directions are one assertion because they are one property: the
    // canonical vocabulary and the set of keys the router can actually route to
    // are the same set. A key with no legacy spelling is dead-on-arrival; a
    // routed key that is not in the vocabulary would not parse as durable state.
    expect(
      [...reachableLayoutKeys(LEGACY_UI_STATE_VOCABULARY)].sort(),
      'canonical layout keys reachable through uiStateRoute',
    ).toEqual([...LAYOUT_EXACT_KEYS].sort())
  })

  it('every dynamic prefix has a legacy spelling that routes to it', () => {
    // Prefix forms never appear in the static vocabulary, so the exact-key
    // assertion above cannot see them. A new prefix with no legacy source is the
    // same defect one level up.
    const probe = 'gateProbeSection'
    const reachedPrefixes = LEGACY_SECTION_PREFIXES.map((legacyPrefix) => {
      const legacyKey = `${legacyPrefix}${probe}`
      expect(uiStateRoute(legacyKey).home, legacyKey).toBe('per-user-replicated')
      const layoutKey = layoutKeyFromLegacy(legacyKey)
      expect(layoutKey, legacyKey).toMatch(new RegExp(`\\.${probe}$`))
      return layoutKey?.slice(0, -(probe.length + 1))
    })
    expect([...new Set(reachedPrefixes)].sort()).toEqual([...LAYOUT_KEY_PREFIXES].sort())
  })

  it('the totality check REFUSES a planted key with no declared home', () => {
    // The gate's own probe, run in-repo: `gateProbeUnrouted` added to the shared
    // vocabulary is reported by name. Without this, the check above could pass
    // for a reason unrelated to what it claims to measure.
    expect(unhomedLayoutKeys([...LAYOUT_EXACT_KEYS, 'gateProbeUnrouted'])).toEqual([
      'gateProbeUnrouted',
    ])
    expect(unhomedLayoutKeys([...LAYOUT_EXACT_KEYS])).toEqual([])
  })
})
