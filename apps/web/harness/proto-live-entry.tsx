/**
 * POD-4537 — the live sidebar demo (round three).
 *
 * A DEV-ONLY page (see `apps/web/proto-live.html`). It is served by the web
 * dev server on the same origin as the app, so the operator's session cookie
 * applies, and it boots the REAL client runtime over the operator's LIVE data:
 * the same `openKernelAssembly` (IndexedDB, this principal) and the same
 * `createClientRuntime` the app's `StoreProvider` uses — no fake transport, no
 * fixture corpus. The prototype arms then read through the round-three
 * per-row feed (`createRowSource`, `createEngineLocals`), exactly as the
 * harness pages do; only the bootstrap is live.
 *
 * READ-ONLY apart from selection. The page issues no write commands: no
 * renames, no stage moves, no mark-read calls of its own. Clicking a row calls
 * the engine's own `setSelectedIssueId` — the same write the legacy control's
 * pressable makes — and the runtime's own eager mark-read may follow, as it
 * does in the app. That selection path is the documented exception; everything
 * else on this page is a read.
 *
 * LIVE DATA, NEVER PUBLISHED. This page renders the operator's real missions.
 * No screenshots, recordings, exports or data dumps of it belong in a commit,
 * an artifact or a mail.
 *
 * DEV-ONLY ON PURPOSE. This file lives under `apps/web/harness/` (outside the
 * `src/` composition roots the phase-2 audit scans, and outside the tsconfig
 * `include`), and the html entry is NOT an input to `vite build` (which takes
 * only `index.html`), so the production bundle — and `web-bundle-budget` —
 * never sees it. Do not import this file from `src/`.
 */

import { useCallback, useEffect, useRef, useState, type JSX, type MouseEvent } from 'react'
import { createRoot } from 'react-dom/client'
import { asIssueId } from '@podium/model'
import { createClientRuntime } from '@podium/client-core/engine'
import { serverConfig, makeTrpc } from '@/app/trpc'
import { openKernelAssembly, type KernelAssembly } from '@/lib/kernelReplica'
import { resolveReplicaPrincipal, recordIdentityEvidence } from '@/lib/use-kernel-replica'
import '@/index.css'
import '@/styles.css'
import { harnessMobxPoolArm } from '../../../packages/worklist-proto/harness/src/adapters/mobx-pool'
import { handPoolArm } from '../../../packages/worklist-proto/arms/hand/pool/arm'
import { legacyControlArmFor } from '../../../packages/worklist-proto/harness/src/legacy-control/arm'
import { createEngineLocals } from '../../../packages/worklist-proto/harness/src/engine-locals'
import { oracleSnapshot } from '../../../packages/worklist-proto/harness/src/oracle/index'
import { createRowSource, type RowSourceHandle } from '../../../packages/worklist-proto/shared/src/row-source'
import { createCommitLog, withCommitLog, type CommitLog } from '../../../packages/worklist-proto/shared/src/row-shell'
import type {
  ArmHandle,
  CheckableArm,
  LocalsSource,
  RowSource,
} from '../../../packages/worklist-proto/shared/src/arm'
import type { LocalsSourceHandle } from '../../../packages/worklist-proto/shared/src/locals-source'
import type { SliceSnapshot } from '../../../packages/worklist-proto/shared/src/slice-types'

// The bundle is fetched, parsed and evaluated (every static import); the page
// clock starts here, as on the harness pages (`scriptAt`).
const scriptAt = performance.now()

type ArmName = 'mobx' | 'hand' | 'control'
const ARM_NAMES: readonly ArmName[] = ['mobx', 'hand', 'control']

function readParams(): { primary: ArmName; secondary: ArmName | null; invalid: string | null } {
  const params = new URLSearchParams(window.location.search)
  const raw = params.get('arm') ?? 'mobx'
  if (!(ARM_NAMES as readonly string[]).includes(raw)) {
    return { primary: 'mobx', secondary: null, invalid: raw }
  }
  const primary = raw as ArmName
  if (params.get('split') !== '1') return { primary, secondary: null, invalid: null }
  const raw2 = params.get('arm2')
  if (raw2 !== null && !(ARM_NAMES as readonly string[]).includes(raw2)) {
    return { primary, secondary: null, invalid: raw2 }
  }
  const secondary = (raw2 as ArmName | null) ?? (primary === 'control' ? 'mobx' : 'control')
  if (secondary === primary) return { primary, secondary: null, invalid: null }
  return { primary, secondary, invalid: null }
}

/** One mounted arm over the shared live runtime: everything a rebuild throws away. */
interface LivePanel {
  name: ArmName
  log: CommitLog
  el: HTMLDivElement | null
  source: RowSourceHandle
  locals: LocalsSourceHandle
  handle: ArmHandle
  unmount: () => void
  parity: { status: 'green' | 'red' | 'live'; firstDifference: string | null; at: number } | null
  lastTotal: number
  lastDelta: number
}

interface LiveBoot {
  assembly: KernelAssembly
  runtime: ReturnType<typeof createClientRuntime>
  replica: ReturnType<KernelAssembly['createReplicaFn']>
  principalLabel: string
  panels: LivePanel[]
  engineMs: number
  buildMs: number
  firstPaintMs: number | null
}

/** Old objects, watched but never held: `survivors()` proves the rebuild dropped them. */
let oldRefs: { label: string; ref: WeakRef<object> }[] = []

function armOf(name: ArmName, boot: { runtime: LiveBoot['runtime'] }): CheckableArm {
  if (name === 'mobx') return harnessMobxPoolArm
  if (name === 'hand') return handPoolArm
  return legacyControlArmFor(boot.runtime)
}

function snapshotRows(snapshot: SliceSnapshot): number {
  return Object.keys(snapshot.rowsById).length
}

/**
 * The first difference between two slice outputs, walking the oracle's order.
 * Mirrors `firstSnapshotDifference` in `packages/worklist-proto/harness/web/entrylib.ts`
 * (the driver compares the same two snapshots after every sample); kept local
 * so this page does not pull the harness's scenario/fixture machinery into the
 * app dev server. The compared snapshots — the arm's and `oracleSnapshot`'s —
 * are the same ones the tests use.
 */
function firstSnapshotDifference(actual: SliceSnapshot, expected: SliceSnapshot): string | null {
  const canonical = (value: unknown): string =>
    JSON.stringify(value, (_key, inner: unknown) =>
      inner !== null && typeof inner === 'object' && !Array.isArray(inner)
        ? Object.fromEntries(
            Object.entries(inner as Record<string, unknown>).sort(([a], [b]) =>
              a < b ? -1 : a > b ? 1 : 0,
            ),
          )
        : inner,
    )
  const ids = (snapshot: SliceSnapshot): string[] => [
    ...snapshot.order.pinnedIds,
    ...snapshot.order.groups.flatMap((group) => [...group.rowIds, ...group.closedIds]),
  ]
  const want = ids(expected)
  for (const id of want) {
    const a = actual.rowsById[id]
    const e = expected.rowsById[id]
    if (a === undefined) return `row ${id}: missing from the arm`
    if (canonical(a) !== canonical(e)) {
      const fields = Object.keys({ ...a, ...e }).filter(
        (field) =>
          canonical((a as unknown as Record<string, unknown>)[field]) !==
          canonical((e as unknown as Record<string, unknown>)[field]),
      )
      return `row ${id}: ${fields
        .map(
          (f) =>
            `${f} arm=${canonical((a as unknown as Record<string, unknown>)[f])} oracle=${canonical((e as unknown as Record<string, unknown>)[f])}`,
        )
        .join('; ')}`
    }
  }
  const extra = Object.keys(actual.rowsById).find((id) => !(id in expected.rowsById))
  if (extra !== undefined) return `row ${extra}: drawn by the arm, not in the oracle`
  if (canonical(actual.order) !== canonical(expected.order)) {
    const got = ids(actual)
    const at = want.findIndex((id, index) => got[index] !== id)
    return at >= 0
      ? `order at ${at}: arm has ${got[at] ?? 'nothing'}, oracle ${want[at]}`
      : 'order: same rows, different grouping'
  }
  return null
}

function heapMB(): number | null {
  const memory = (performance as { memory?: { usedJSHeapSize?: number } }).memory
  return memory?.usedJSHeapSize === undefined ? null : memory.usedJSHeapSize / 1_048_576
}

async function bootLive(names: readonly ArmName[], onFatal: (message: string) => void): Promise<LiveBoot> {
  const engineBegin = performance.now()
  const config = serverConfig(window.location)
  const trpc = makeTrpc(config.httpOrigin)
  // The app's own auth flow: `/auth/status` (or the single retained offline
  // namespace), never the URL and never a raw storage key.
  const principalStr = await resolveReplicaPrincipal({ httpOrigin: config.httpOrigin })
  const assembly = await openKernelAssembly({
    trpc,
    httpOrigin: config.httpOrigin,
    principal: principalStr,
    evidence: recordIdentityEvidence(principalStr),
  })
  // The app's own runtime construction: the same arguments `StoreProvider`
  // passes (principal-bound replica, feed, outbox), minus the store chrome.
  const runtime = createClientRuntime({
    principal: assembly.principal,
    config,
    api: trpc,
    onFatalError: onFatal,
    createReplicaFn: assembly.createReplicaFn,
    feed: assembly.feed,
    createOutboxFn: assembly.createOutboxFn,
  })
  runtime.start()
  const replica = assembly.createReplicaFn(assembly.principal)
  const engineMs = performance.now() - engineBegin
  const buildBegin = performance.now()
  const panels: LivePanel[] = names.map((name) => {
    const log = createCommitLog()
    const source = createRowSource(runtime, replica, { mode: 'overlaid' })
    const locals = createEngineLocals(runtime)
    const handle = withCommitLog(log, () =>
      armOf(name, { runtime }).create(source.source as RowSource, locals.source as LocalsSource),
    )
    return {
      name,
      log,
      el: null,
      source,
      locals,
      handle,
      unmount: () => {},
      parity: null,
      lastTotal: 0,
      lastDelta: 0,
    }
  })
  const buildMs = performance.now() - buildBegin
  return {
    assembly,
    runtime,
    replica,
    principalLabel: principalStr,
    panels,
    engineMs,
    buildMs,
    firstPaintMs: null,
  }
}

function mountPanel(boot: LiveBoot, panel: LivePanel, el: HTMLDivElement): void {
  panel.el = el
  panel.unmount = withCommitLog(panel.log, () => panel.handle.mountWeb(el))
}

function teardown(boot: LiveBoot): void {
  oldRefs = []
  for (const panel of boot.panels) {
    try {
      panel.unmount()
    } catch {
      // Best effort: a half-mounted panel must not block the teardown.
    }
    try {
      panel.handle.dispose()
    } catch {
      // Same: the runtime destroy below is what guarantees silence.
    }
    try {
      panel.locals.dispose()
    } catch {
      // Best effort.
    }
    try {
      panel.source.dispose()
    } catch {
      // Best effort.
    }
  }
  const store = (() => {
    try {
      return boot.runtime.getSnapshot()
    } catch {
      return null
    }
  })()
  oldRefs = [
    { label: 'runtime', ref: new WeakRef(boot.runtime) },
    ...(store === null ? [] : [{ label: 'store', ref: new WeakRef(store) }]),
    { label: 'replica', ref: new WeakRef(boot.replica) },
    ...boot.panels.flatMap((panel) => [
      { label: `arm:${panel.name}`, ref: new WeakRef(panel.handle) },
      { label: `rowSource:${panel.name}`, ref: new WeakRef(panel.source) },
    ]),
  ]
  try {
    boot.runtime.destroy()
  } catch {
    // Destroy is irreversible; a throw here still ends with disposal below.
  }
  void boot.assembly.dispose().catch(() => {})
}

/**
 * The arm's output against the oracle's over the live engine. Live data moves
 * under the check (agents work while the operator watches), so one comparison
 * can catch the two snapshots on either side of a publication and report a
 * difference that is already gone. Retry while the answer moves: green the
 * moment they agree, `live` while each attempt names a DIFFERENT row (the
 * store is changing faster than the check), red only when the same row
 * differs across attempts. A click never selects during the check — selection
 * is locals-only and cannot move a row — so a stable red is the arm's, not
 * the operator's.
 */
async function checkParity(boot: LiveBoot, panel: LivePanel): Promise<void> {
  const seen = new Map<string, number>()
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let firstDifference: string | null
    try {
      firstDifference = firstSnapshotDifference(
        panel.handle.snapshot(),
        oracleSnapshot(boot.runtime.getSnapshot()),
      )
    } catch (error) {
      firstDifference = `parity threw: ${error instanceof Error ? error.message : String(error)}`
    }
    if (firstDifference === null) {
      panel.parity = { status: 'green', firstDifference: null, at: Date.now() }
      return
    }
    seen.set(firstDifference, (seen.get(firstDifference) ?? 0) + 1)
    if (seen.size > 1) {
      panel.parity = { status: 'live', firstDifference, at: Date.now() }
      return
    }
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 500))
  }
  const [stable] = seen.keys()
  panel.parity = { status: 'red', firstDifference: stable ?? 'unknown', at: Date.now() }
}

function onRowClick(boot: LiveBoot, event: MouseEvent): void {
  const target = event.target as HTMLElement | null
  const row = target?.closest?.('[data-issue-row]') as HTMLElement | null
  const id = row?.getAttribute('data-issue-row')
  if (id === null || id === undefined || id === '') return
  // The engine's own selection write — the same one the legacy control's
  // pressable makes. Locals-only: arms hear it on the locals channel and the
  // runtime's own eager mark-read may follow, as in the app.
  boot.runtime.getSnapshot().setSelectedIssueId(asIssueId(id))
}

declare global {
  interface Window {
    __protoLive?: {
      survivors(): string[]
      parity(): Record<string, string>
      rebuild(): Promise<void>
      info(): Record<string, unknown>
    }
  }
}

function PanelView({
  boot,
  panel,
  mountRef,
}: {
  boot: LiveBoot
  panel: LivePanel
  mountRef: (el: HTMLDivElement | null) => void
}): JSX.Element {
  const parity = panel.parity
  return (
    <section style={{ flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '4px 8px', fontSize: 12, borderBottom: '1px solid #333' }}>
        <strong>{panel.name}</strong>
        {' · '}commits <strong>{panel.lastTotal}</strong>
        {' '}(last poll <strong>+{panel.lastDelta}</strong>)
        {' · '}mounts <strong>{[...panel.log.mounts.values()].reduce((n, c) => n + c, 0)}</strong>
        {' · '}rowsDerived {panel.handle.stats.rowsDerived}
        {' · '}rollups {panel.handle.stats.rollupsDerived}
        {' · '}feed flushes {panel.source.stats.flushes}
        {'/'}events {panel.source.stats.events}
        {'/'}enum {panel.source.stats.enumerations}
        {' · '}parity{' '}
        {parity === null ? (
          <span>pending</span>
        ) : parity.status === 'green' ? (
          <span style={{ color: 'green' }}>green</span>
        ) : parity.status === 'live' ? (
          <span style={{ color: 'orange' }}>LIVE {parity.firstDifference}</span>
        ) : (
          <span style={{ color: 'red' }}>RED {parity.firstDifference}</span>
        )}
      </div>
      <div
        ref={mountRef}
        onClick={(event) => onRowClick(boot, event)}
        style={{ height: '72vh', overflowY: 'auto', borderRight: '1px solid #333' }}
      />
    </section>
  )
}

function LivePage({ names }: { names: readonly ArmName[] }): JSX.Element {
  const [boot, setBoot] = useState<LiveBoot | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [, setTick] = useState(0)
  const bootRef = useRef<LiveBoot | null>(null)
  const mountEls = useRef(new Map<ArmName, HTMLDivElement | null>())
  const settledRef = useRef<LiveBoot | null>(null)
  const namesKey = names.join('+')

  /** After every panel's list is mounted: drain lazy loads, parity, first paint. Untimed. */
  const settleBoot = async (next: LiveBoot): Promise<void> => {
    if (settledRef.current === next) return
    settledRef.current = next
    for (const panel of next.panels) await panel.handle.settleLoads?.()
    for (const panel of next.panels) await checkParity(next, panel)
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    next.firstPaintMs = performance.now() - scriptAt
    setTick((n) => n + 1)
  }

  const mountRef = useCallback(
    (panel: LivePanel, el: HTMLDivElement | null) => {
      mountEls.current.set(panel.name, el)
      const current = bootRef.current
      if (el !== null && current !== null) {
        if (panel.el === null) mountPanel(current, panel, el)
        if (current.panels.every((candidate) => candidate.el !== null)) {
          // A ref callback runs inside React's commit: the arm's settle drains
          // through `flushSync`, which React forbids there. Settle on the next
          // task instead — the mount itself is already committed.
          setTimeout(() => void settleBoot(current), 0)
        }
      }
    },
    // bootRef/settledRef are refs; the callback identity only needs boot changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [boot],
  )

  const rebuild = async (): Promise<void> => {
    const previous = bootRef.current
    if (previous !== null) teardown(previous)
    bootRef.current = null
    settledRef.current = null
    setBoot(null)
    setFailure(null)
    try {
      const next = await bootLive(names, (message) => setFailure(message))
      bootRef.current = next
      setBoot(next)
      // Containers survive a rebuild (same DOM nodes), so mount explicitly,
      // then settle once every panel has its element.
      for (const panel of next.panels) {
        const el = mountEls.current.get(panel.name)
        if (el !== null && panel.el === null) mountPanel(next, panel, el)
      }
      if (next.panels.every((panel) => panel.el !== null)) await settleBoot(next)
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
    }
  }

  // One boot per page load (and per explicit rebuild, never per render: no
  // module binding holds the runtime, so a rebuild can drop the old one).
  // Mounting happens in `mountRef` once the panel containers render; settling
  // waits for every panel to be mounted.
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const next = await bootLive(names, (message) => {
          if (alive) setFailure(message)
        })
        if (!alive) {
          teardown(next)
          return
        }
        bootRef.current = next
        setBoot(next)
      } catch (error) {
        if (alive) setFailure(error instanceof Error ? error.message : String(error))
      }
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [namesKey])

  // Poll counters twice a second; parity every 10 s. Untimed reads only.
  useEffect(() => {
    if (boot === null) return
    const timer = setInterval(() => {
      for (const panel of boot.panels) {
        const total = panel.log.total()
        panel.lastDelta = total - panel.lastTotal
        panel.lastTotal = total
      }
      setTick((n) => n + 1)
    }, 500)
    const parityTimer = setInterval(() => {
      void (async () => {
        for (const panel of boot.panels) await checkParity(boot, panel)
        setTick((n) => n + 1)
      })()
    }, 10_000)
    return () => {
      clearInterval(timer)
      clearInterval(parityTimer)
    }
  }, [boot])

  useEffect(() => {
    window.__protoLive = {
      survivors: () =>
        oldRefs
          .filter((entry) => entry.ref.deref() !== undefined)
          .map((entry) => entry.label),
      parity: () =>
        Object.fromEntries(
          (bootRef.current?.panels ?? []).map((panel) => [
            panel.name,
            panel.parity === null
              ? 'pending'
              : panel.parity.status === 'green'
                ? 'green'
                : `${panel.parity.status.toUpperCase()} ${panel.parity.firstDifference}`,
          ]),
        ),
      rebuild,
      info: () => ({
        principal: bootRef.current?.principalLabel ?? null,
        arms: (bootRef.current?.panels ?? []).map((panel) => panel.name),
        heapMB: heapMB(),
      }),
    }
    return () => {
      window.__protoLive = undefined
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (failure !== null) {
    return (
      <main style={{ padding: 24, fontFamily: 'sans-serif' }}>
        <h1>Proto live — boot failed</h1>
        <p>
          {/auth|principal|sign/i.test(failure)
            ? 'Sign in through the app at / first (this page reuses its session), then reload.'
            : failure}
        </p>
        <pre style={{ whiteSpace: 'pre-wrap' }}>{failure}</pre>
        <button type="button" onClick={() => void rebuild()}>
          Retry
        </button>
      </main>
    )
  }

  if (boot === null) {
    return (
      <main style={{ padding: 24, fontFamily: 'sans-serif' }}>
        <h1>Proto live</h1>
        <p>Booting the live runtime over your data…</p>
      </main>
    )
  }

  const store = boot.runtime.getSnapshot()
  const heap = heapMB()
  return (
    <main style={{ fontFamily: 'sans-serif', fontSize: 13 }}>
      <header style={{ padding: '8px 12px', borderBottom: '2px solid #666' }}>
        <h1 style={{ fontSize: 15, margin: '0 0 4px' }}>
          Proto live — {names.join(' + ')} over your data
        </h1>
        <div>
          Read-only apart from selection: this page issues no write commands. Clicking a row
          selects it through the engine&apos;s own selection write (as the legacy control does).
        </div>
        <div>
          principal <strong>{boot.principalLabel}</strong>
          {' · '}issues {store.issues.length}
          {' · '}sessions {store.sessions.length}
          {boot.panels.map((panel) => (
            <span key={panel.name}>
              {' · '}visible({panel.name}) {snapshotRows(panel.handle.snapshot())}
            </span>
          ))}
          {' · '}heap {heap === null ? 'n/a' : `${heap.toFixed(0)} MB`}
          {' · '}engine {boot.engineMs.toFixed(0)} ms
          {' · '}build {boot.buildMs.toFixed(0)} ms
          {' · '}first paint{' '}
          {boot.firstPaintMs === null ? '…' : `${boot.firstPaintMs.toFixed(0)} ms`}
        </div>
        <div style={{ marginTop: 4 }}>
          <button
            type="button"
            onClick={() => {
              void (async () => {
                for (const panel of boot.panels) await checkParity(boot, panel)
                setTick((n) => n + 1)
              })()
            }}
          >
            Check parity now
          </button>{' '}
          <button type="button" onClick={() => void rebuild()}>
            Rebuild (principal switch path)
          </button>{' '}
          <span>
            arms: ?arm=mobx|hand|control · side by side: ?split=1 (&amp;arm2=…) · parity ticks
            every 10 s · console: __protoLive.survivors()
          </span>
        </div>
      </header>
      <div style={{ display: 'flex', minWidth: 0 }}>
        {boot.panels.map((panel) => (
          <PanelView
            key={panel.name}
            boot={boot}
            panel={panel}
            mountRef={(el) => mountRef(panel, el)}
          />
        ))}
      </div>
    </main>
  )
}

const params = readParams()
const root = document.getElementById('root')!

if (params.invalid !== null) {
  createRoot(root).render(
    <main style={{ padding: 24, fontFamily: 'sans-serif' }}>
      <h1>Proto live — unknown arm</h1>
      <p>
        ?arm={params.invalid} is not an arm. Use ?arm=mobx|hand|control, ?split=1 for side by
        side.
      </p>
    </main>,
  )
} else {
  const names = params.secondary === null ? [params.primary] : [params.primary, params.secondary]
  createRoot(root).render(<LivePage names={names} />)
}
