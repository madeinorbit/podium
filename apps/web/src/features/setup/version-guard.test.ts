import { addSink, type LogRecord, resetLogging, setLogLevel } from '@podium/logger'
import { WIRE_VERSION, wireSchemaDigest } from '@podium/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { currentSkew, resetSkewNotice } from '@/app/skew-notice'
import { reloadBudgetSpent } from '@/lib/reload-budget'
import {
  checkServerVersion,
  forceReload,
  recoverFromWireSkew,
  resetWireSkewRecovery,
} from './version-guard'

const ORIGIN = 'https://relay.test'
const COUNTER_KEY = 'podium.vreload'

/** The budget as the guard writes it: attempts, and the served build they were spent against. */
const budgetFor = (target: string, spent: number) => JSON.stringify({ n: spent, t: target })
/** The key the guard derives from a `/version` body — `wireVersion/wireSchemaDigest`. */
const targetOf = (wire: number, digest?: string) => `${wire}/${digest ?? '?'}`

let reload: ReturnType<typeof vi.fn>
let unregister: ReturnType<typeof vi.fn>
let cacheDelete: ReturnType<typeof vi.fn>
let store: Map<string, string>

/** A minimal `/version` fetch Response stub. */
function versionResponse(body: unknown): {
  ok: boolean
  status: number
  json: () => Promise<unknown>
} {
  return { ok: true, status: 200, json: async () => body }
}

beforeEach(() => {
  resetWireSkewRecovery()
  reload = vi.fn()
  unregister = vi.fn().mockResolvedValue(true)
  cacheDelete = vi.fn().mockResolvedValue(true)
  store = new Map<string, string>()

  vi.stubGlobal('navigator', {
    serviceWorker: { getRegistrations: vi.fn().mockResolvedValue([{ unregister }]) },
  })
  vi.stubGlobal('caches', {
    keys: vi.fn().mockResolvedValue(['podium-precache', 'podium-runtime']),
    delete: cacheDelete,
  })
  vi.stubGlobal('location', { reload })
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, String(v))
    },
    removeItem: (k: string) => {
      store.delete(k)
    },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('forceReload', () => {
  it('unregisters every service worker, deletes every cache, then reloads', async () => {
    await forceReload()
    expect(unregister).toHaveBeenCalledTimes(1)
    expect(cacheDelete).toHaveBeenCalledTimes(2)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('still reloads when the service-worker + caches APIs are unavailable', async () => {
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('caches', undefined)
    await forceReload()
    expect(reload).toHaveBeenCalledTimes(1)
  })
})

describe('checkServerVersion', () => {
  it('returns ok and does not reload when the wire versions match, clearing a stale counter', async () => {
    store.set(COUNTER_KEY, '1') // a leftover counter from an earlier blip
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        versionResponse({
          wireVersion: WIRE_VERSION,
          minSupportedVersion: WIRE_VERSION,
          appVersion: 'test',
        }),
      ),
    )
    const result = await checkServerVersion(ORIGIN)
    expect(result).toBe('ok')
    expect(reload).not.toHaveBeenCalled()
    expect(store.has(COUNTER_KEY)).toBe(false)
  })

  it('hard-reloads when the server wire version differs from the bundle', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        versionResponse({
          wireVersion: WIRE_VERSION + 1,
          minSupportedVersion: WIRE_VERSION,
          appVersion: 'test',
        }),
      ),
    )
    const result = await checkServerVersion(ORIGIN)
    expect(result).toBe('reloaded')
    expect(unregister).toHaveBeenCalledTimes(1)
    expect(cacheDelete).toHaveBeenCalledTimes(2)
    expect(reload).toHaveBeenCalledTimes(1)
    // First reload recorded — AGAINST the build it is aimed at, which is what lets a later,
    // different build start over instead of inheriting this attempt (POD-2253).
    expect(store.get(COUNTER_KEY)).toBe(budgetFor(targetOf(WIRE_VERSION + 1), 1))
  })

  it('does not reload when this client is ahead of its server', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        versionResponse({
          wireVersion: WIRE_VERSION - 1,
          minSupportedVersion: WIRE_VERSION - 1,
          appVersion: 'test',
        }),
      ),
    )
    const result = await checkServerVersion(ORIGIN)
    expect(result).toBe('server-behind')
    expect(reload).not.toHaveBeenCalled()
  })

  it('tells the user the server is behind, not that the build is stale', async () => {
    resetSkewNotice()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        versionResponse({
          wireVersion: WIRE_VERSION - 1,
          minSupportedVersion: WIRE_VERSION - 1,
          appVersion: 'test',
        }),
      ),
    )
    await checkServerVersion(ORIGIN)
    expect(currentSkew()).toEqual(
      expect.objectContaining({
        message: expect.stringContaining('server'),
      }),
    )
    expect(currentSkew()?.message).not.toContain('bun run build')
  })

  it('does not burn a reload attempt on the server-behind path', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        versionResponse({
          wireVersion: WIRE_VERSION - 1,
          minSupportedVersion: WIRE_VERSION - 1,
        }),
      ),
    )
    await checkServerVersion(ORIGIN)
    expect(store.has(COUNTER_KEY)).toBe(false)
  })

  it('hard-reloads when the bundle is older than the server minimum', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        versionResponse({
          wireVersion: WIRE_VERSION,
          minSupportedVersion: WIRE_VERSION + 1,
          appVersion: 'test',
        }),
      ),
    )
    const result = await checkServerVersion(ORIGIN)
    expect(result).toBe('reloaded')
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('blocks (no further reload) after two reloads at the same build, surfacing an error', async () => {
    // Already reloaded twice this session AT THIS BUILD — the loop the budget exists to stop.
    store.set(COUNTER_KEY, budgetFor(targetOf(WIRE_VERSION + 1), 2))
    // A REAL sink with no pinned level, per the epic's testing note: the
    // diagnostic moved from the console to the logger, and a capture pinned at
    // `trace` would observe records a deployment never emits.
    const logged: LogRecord[] = []
    setLogLevel('warn')
    addSink({ name: 'capture', write: (record) => logged.push(record) })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        versionResponse({
          wireVersion: WIRE_VERSION + 1,
          minSupportedVersion: WIRE_VERSION,
          appVersion: 'test',
        }),
      ),
    )
    const result = await checkServerVersion(ORIGIN)
    expect(result).toBe('blocked')
    expect(reload).not.toHaveBeenCalled()
    expect(logged.filter((r) => r.level === 'error')).toHaveLength(1)
    resetLogging()
  })

  it('treats a fetch rejection as ok (never blocks on a flaky /version)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    const result = await checkServerVersion(ORIGIN)
    expect(result).toBe('ok')
    expect(reload).not.toHaveBeenCalled()
  })

  it('treats a non-JSON /version body as ok (old server serving the SPA shell)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON')
        },
      }),
    )
    const result = await checkServerVersion(ORIGIN)
    expect(result).toBe('ok')
    expect(reload).not.toHaveBeenCalled()
  })
})

/**
 * THE CHECK THE WIRE VERSION COULD NOT MAKE (POD-1610).
 *
 * The stale bundle and its server agreed on wire 2 for three days while failing
 * to understand each other, because `WIRE_VERSION` is coarse on purpose. These
 * cases pin the finer one — and, as importantly, pin the two ways it must NOT
 * fire: on a matched pair, and on a server too old to advertise a digest at all.
 */
describe('checkServerVersion — schema digest', () => {
  const matched = {
    wireVersion: WIRE_VERSION,
    minSupportedVersion: WIRE_VERSION,
    appVersion: 'test',
    wireSchemaDigest: wireSchemaDigest(),
  }

  beforeEach(() => {
    resetSkewNotice()
  })

  it('CAN SAY NO: a matched pair does not reload and raises no notice', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(versionResponse(matched)))
    expect(await checkServerVersion(ORIGIN)).toBe('ok')
    expect(reload).not.toHaveBeenCalled()
    expect(currentSkew()).toBeNull()
  })

  it('says nothing when the server does not advertise a digest at all', async () => {
    // An older server. Silence is not skew — treating it as skew would reload-loop
    // every deployment that predates the field.
    const { wireSchemaDigest: _omitted, ...noDigest } = matched
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(versionResponse(noDigest)))
    expect(await checkServerVersion(ORIGIN)).toBe('ok')
    expect(currentSkew()).toBeNull()
  })

  it('hard-reloads on a digest mismatch, even at the same wire version', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(versionResponse({ ...matched, wireSchemaDigest: 'deadbeefdeadbeef' })),
    )
    expect(await checkServerVersion(ORIGIN)).toBe('reloaded')
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('raises a VISIBLE notice once reloading has failed twice', async () => {
    store.set(COUNTER_KEY, budgetFor(targetOf(WIRE_VERSION, 'deadbeefdeadbeef'), 2))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(versionResponse({ ...matched, wireSchemaDigest: 'deadbeefdeadbeef' })),
    )
    expect(await checkServerVersion(ORIGIN)).toBe('blocked')
    // The whole point: 'blocked' used to be a console.error and nothing else.
    const notice = currentSkew()
    expect(notice?.source).toBe('boot-digest')
    expect(notice?.message).toContain('different app builds')
    // ONE REMEDY, NOT A SECOND PRESCRIPTION (POD-2102, spec §6.1). The banner
    // used to name a specific button; that button is the panel's business, and
    // naming it here was how the two surfaces came to recommend different
    // things. It points at the panel now.
    expect(notice?.message).toContain('update panel')
    expect(notice?.message).not.toContain('bun run build')
  })

  /**
   * THE BUDGET IS SPENT AGAINST A BUILD, NOT INTO THE AIR (POD-2253).
   *
   * The first real update on a live instance changed the wire digest, which is the moment the
   * guard exists for — and it met a budget already emptied against an earlier, unrelated
   * mismatch, so the tab never reloaded and stayed dead until the service worker was cleared by
   * hand. These cases pin BOTH halves: a new digest earns a fresh attempt, and a repeat against
   * the same digest still stops, because the second is the loop the budget is actually for.
   */
  const spentDigest = 'deadbeefdeadbeef'
  const nextDigest = 'feedfacefeedface'

  const serveDigest = (digest: string) =>
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(versionResponse({ ...matched, wireSchemaDigest: digest })),
    )

  it('a budget spent against an EARLIER build does not strand the tab on a new one', async () => {
    store.set(COUNTER_KEY, budgetFor(targetOf(WIRE_VERSION, spentDigest), 2))
    serveDigest(nextDigest)
    expect(await checkServerVersion(ORIGIN)).toBe('reloaded')
    expect(reload).toHaveBeenCalledTimes(1)
    // And the fresh attempt is booked against the NEW build, not added to the old tally.
    expect(store.get(COUNTER_KEY)).toBe(budgetFor(targetOf(WIRE_VERSION, nextDigest), 1))
  })

  it('CAN SAY NO: two reloads at the SAME digest still stop the loop', async () => {
    store.set(COUNTER_KEY, budgetFor(targetOf(WIRE_VERSION, spentDigest), 2))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    serveDigest(spentDigest)
    expect(await checkServerVersion(ORIGIN)).toBe('blocked')
    expect(reload).not.toHaveBeenCalled()
  })

  it('a pre-POD-2253 bare counter reads as unspent and is replaced by the keyed form', async () => {
    // The old spelling records attempts against a build it cannot name, so it can never match a
    // target — the tabs holding one are exactly the tabs this stranded, and they get another
    // attempt. The second assertion is the one with teeth: the value it leaves behind must be
    // the keyed form, or the next check would read this same unnameable counter again forever.
    store.set(COUNTER_KEY, '2')
    serveDigest(nextDigest)
    expect(await checkServerVersion(ORIGIN)).toBe('reloaded')
    expect(reload).toHaveBeenCalledTimes(1)
    expect(store.get(COUNTER_KEY)).toBe(budgetFor(targetOf(WIRE_VERSION, nextDigest), 1))
  })

  it('a server that advertises no digest is ONE target, not a new one every poll', async () => {
    // Otherwise silence would look like perpetual change and the budget would never bind.
    const { wireSchemaDigest: _omitted, ...noDigest } = matched
    store.set(COUNTER_KEY, budgetFor(targetOf(WIRE_VERSION + 1), 2))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(versionResponse({ ...noDigest, wireVersion: WIRE_VERSION + 1 })),
    )
    expect(await checkServerVersion(ORIGIN)).toBe('blocked')
    expect(reload).not.toHaveBeenCalled()
  })

  it('records the spent reload budget so the panel can explain it afterwards', async () => {
    store.set(COUNTER_KEY, budgetFor(targetOf(WIRE_VERSION, 'deadbeefdeadbeef'), 2))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(versionResponse({ ...matched, wireSchemaDigest: 'deadbeefdeadbeef' })),
    )
    expect(await checkServerVersion(ORIGIN)).toBe('blocked')
    expect(reloadBudgetSpent()).toBe(true)
  })
})

/**
 * THE TAB THAT WAS ALREADY OPEN (POD-2253).
 *
 * The boot check saves the tab you open after an update. The tab that was open THROUGH the
 * update is the one this issue is about: a wire-schema change breaks its ability to decode, and
 * therefore its ability to be clicked, and the only thing it got was a banner asking it to press
 * a button that no longer works. Refused frames are the transport saying so out loud.
 */
describe('recoverFromWireSkew', () => {
  const matched = {
    wireVersion: WIRE_VERSION,
    minSupportedVersion: WIRE_VERSION,
    appVersion: 'test',
    wireSchemaDigest: wireSchemaDigest(),
  }

  it('forces the takeover when the server is genuinely serving a different build', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(versionResponse({ ...matched, wireSchemaDigest: 'deadbeef' })),
    )
    expect(await recoverFromWireSkew(ORIGIN, { refusedFrames: 3 })).toBe('reloaded')
    expect(unregister).toHaveBeenCalledTimes(1)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('CAN SAY NO: a matching digest means the skew is not a stale shell, so it does nothing', async () => {
    // A reload here would be a guess dressed as a remedy — the served build is the one we have.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(versionResponse(matched)))
    expect(await recoverFromWireSkew(ORIGIN, { refusedFrames: 3 })).toBe('ok')
    expect(reload).not.toHaveBeenCalled()
  })

  it('CAN SAY NO: quarantined rows alone are not grounds to take a tab away from its user', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await recoverFromWireSkew(ORIGIN, { refusedFrames: 0 })).toBe('ignored')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
  })

  it('acts once per page load, however many frames the transport refuses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(versionResponse({ ...matched, wireSchemaDigest: 'deadbeef' })),
    )
    expect(await recoverFromWireSkew(ORIGIN, { refusedFrames: 1 })).toBe('reloaded')
    expect(await recoverFromWireSkew(ORIGIN, { refusedFrames: 1 })).toBe('ignored')
    expect(reload).toHaveBeenCalledTimes(1)
  })
})

/**
 * ITERATION MODE (POD-2513). A page served from source by `bun run iterate` sits
 * in front of the INSTALLED server, so a wire mismatch is the expected state
 * whenever the branch has touched the protocol — and no reload can resolve it,
 * because the fresh bundle is the same source. Reloading twice and then
 * declaring the served build stale would be two wasted reloads and a wrong
 * diagnosis, on a page whose whole purpose is to differ.
 */
describe('checkServerVersion in iteration mode', () => {
  const mismatched = () =>
    versionResponse({ wireVersion: WIRE_VERSION + 1, minSupportedVersion: WIRE_VERSION + 1 })

  afterEach(() => {
    vi.unstubAllEnvs()
    resetSkewNotice()
  })

  it('never reloads, and says the page is source rather than stale', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mismatched()))
    expect(await checkServerVersion(ORIGIN, true)).toBe('iteration')
    expect(reload).not.toHaveBeenCalled()
    expect(currentSkew()?.message).toMatch(/iteration mode/i)
  })

  /**
   * The common VPS case, and the one a wire-number sentence gets wrong: the
   * installed server is simply an older commit, so both sides are on the same
   * wire VERSION and only the schema digest differs. "wire 2 against this
   * bundle's 2" was the first wording, seen in a real browser against the live
   * server — it names two identical numbers and explains nothing.
   */
  it('names the commit difference, not the wire number, on a schema skew', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        versionResponse({
          wireVersion: WIRE_VERSION,
          minSupportedVersion: WIRE_VERSION,
          wireSchemaDigest: 'a-different-build',
        }),
      ),
    )
    expect(await checkServerVersion(ORIGIN, true)).toBe('iteration')
    const message = currentSkew()?.message ?? ''
    expect(message).toMatch(/different commit/i)
    expect(message).toMatch(/wire schema/i)
    expect(message).not.toMatch(new RegExp(`wire ${WIRE_VERSION}\\b`))
  })

  it('spends no reload budget, so leaving iteration mode starts with a full one', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mismatched()))
    await checkServerVersion(ORIGIN, true)
    expect(store.get(COUNTER_KEY)).toBeUndefined()
    expect(reloadBudgetSpent()).toBe(false)
  })

  it('still reports a clean match as ok — iteration mode suppresses nothing else', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        versionResponse({
          wireVersion: WIRE_VERSION,
          minSupportedVersion: WIRE_VERSION,
          wireSchemaDigest: wireSchemaDigest(),
        }),
      ),
    )
    expect(await checkServerVersion(ORIGIN, true)).toBe('ok')
    expect(currentSkew()).toBeNull()
  })

  it('reloads as usual when iteration mode is off', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mismatched()))
    expect(await checkServerVersion(ORIGIN, false)).toBe('reloaded')
    expect(reload).toHaveBeenCalled()
  })
})
