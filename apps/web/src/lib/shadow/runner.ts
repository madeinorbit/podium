/**
 * THE TWO-CONNECTION SHADOW COMPARISON (POD-1223).
 *
 * ---------------------------------------------------------------------------
 * WHY TWO CONNECTIONS, AND WHY THAT IS NOT AN IMPLEMENTATION DETAIL
 * ---------------------------------------------------------------------------
 *
 * `SocketHub` refuses `feed` together with `fetchChangesSince` at construction:
 * the two are the same read served by two wire versions, and one hub holding
 * both would apply v1 lists and v2 frames onto one client. That refusal is what
 * forces this shape — and the shape is the point. If one hub could hold both,
 * one path would be FEEDING the other and the comparison would be vacuous: the
 * legacy snapshot would agree with the kernel snapshot because it was derived
 * from it, and the harness would report "no divergence" while measuring nothing.
 *
 * So this opens a SECOND socket, at wire v1, with its OWN in-memory legacy
 * replica. Two independent clients of the same server, and the only thing they
 * share is the Authority.
 *
 * ---------------------------------------------------------------------------
 * WHY THE LEGACY SIDE IS IN-MEMORY
 * ---------------------------------------------------------------------------
 *
 * The shadow replica must not touch the persisted localStorage collections the
 * off-flag build uses: a user who turns the flag on, runs the shadow, and turns
 * it off again must find their legacy replica exactly as they left it. An
 * in-memory storage also makes each sample start from a known cold client, so a
 * divergence cannot be inherited from a previous session's leftovers.
 *
 * `memoryStorage()` IS NOW LOAD-BEARING IN A SECOND WAY (POD-1252), and an edit
 * that swapped it for `window.localStorage` would break more than it looks.
 * The client audit's `unattributed-store-read` item grades composition roots that
 * adopt a PERSISTED store without establishing whose it is; this root is exempt
 * because its store demonstrably persists nothing, and the exemption is read off
 * this construction rather than granted by name. So the swap would both start
 * adopting the user's rows and re-arm the audit against this file. `runner.test.ts`
 * asserts localStorage is untouched across a sample, so it goes red first.
 *
 * ---------------------------------------------------------------------------
 * WHEN A SAMPLE IS TAKEN, AND WHY `could-not-sample` IS A FAILURE
 * ---------------------------------------------------------------------------
 *
 * Basis §2.3: a snapshot taken during a bootstrap walk compares a half-installed
 * slice against a whole one and reports noise. So a sample is taken only when
 * the kernel replica's posture is `live` or `stale` and the legacy connection is
 * up. A run that cannot reach a quiescent point inside its budget reports
 * `could-not-sample`, which is a FAILURE TO GATE — not a pass. Reporting it as
 * a pass is how a comparison becomes a rubber stamp without anyone deciding to
 * make it one.
 */

import {
  createReplica,
  entityForKind,
  memoryStorage,
  type Replica,
} from '@podium/client-core/replica'
import type { Replica as KernelReplica, ReplicaEvent } from '@podium/sync/replica'
import { SocketHub } from '@podium/terminal-client'
import type { Trpc } from '@/app/trpc'
import {
  type ClassifyInput,
  classifySample,
  contentDigest,
  type ShadowSample,
  type Snapshot,
  snapshotKey,
} from './classify'

export type ShadowReport =
  | ({ readonly status: 'sampled'; readonly at: number } & ShadowSample)
  | {
      readonly status: 'could-not-sample'
      readonly at: number
      /** What was still moving when the budget ran out. */
      readonly reason: string
    }

export interface ShadowRunnerOptions {
  readonly kernel: KernelReplica
  readonly trpc: Trpc
  readonly wsClientUrl: string
  /** Subscribe to the kernel's event stream (the assembly's fan-out). */
  readonly onKernelEvent: (listener: (event: ReplicaEvent) => void) => () => void
  readonly onReport: (report: ShadowReport) => void
  /**
   * Whether the server evaluates visibility per principal, read from
   * `/version`'s `feedScoping` at boot — NOT inferred from the slice, which
   * would be the harness guessing about visibility from the shape of the data.
   */
  readonly authorityScoped: boolean
  /** How long to wait for a quiescent point before reporting could-not-sample. */
  readonly quiesceBudgetMs?: number
  /** Seam for tests; defaults to a real SocketHub. */
  readonly createHub?: (opts: ConstructorParameters<typeof SocketHub>[0]) => SocketHub
  readonly now?: () => number
}

export const DEFAULT_QUIESCE_BUDGET_MS = 10_000

/** The digest stored for an authority key. Never compared — see
 *  `authoritySnapshot` — and named so a reader is not left wondering. */
const PRESENT = '<authority-presence-only>'

/** The kinds the engine's read model renders — the same five the facade projects. */
const KINDS = ['sessions', 'issues', 'conversations', 'automations', 'automationRuns'] as const

export interface ShadowRunner {
  /** Take one sample now (awaiting quiescence within the budget). */
  sample(): Promise<ShadowReport>
  stop(): void
}

export function startShadowComparison(options: ShadowRunnerOptions): ShadowRunner {
  const now = options.now ?? (() => Date.now())
  const budget = options.quiesceBudgetMs ?? DEFAULT_QUIESCE_BUDGET_MS

  // ---- the SECOND connection: wire v1, its own replica ---------------------
  const legacy: Replica = createReplica({
    storage: memoryStorage(),
    // No cross-tab events and no key enumeration: this replica is private to
    // the comparison and must not adopt anything from the real one.
    enumerateKeys: () => [],
    keyPrefix: 'podium.shadow-legacy',
  })
  const make = options.createHub ?? ((opts) => new SocketHub(opts))
  const hub = make({
    url: options.wsClientUrl,
    viewport: { cols: 80, rows: 24, dpr: 1 },
    onError: () => {
      // The shadow connection failing must never surface as an app error — it
      // is an observer. It surfaces as could-not-sample instead, which fails
      // the gate without breaking the session.
    },
    fetchChangesSince: (cursor) => options.trpc.sync.changesSince.query({ cursor }),
    onMetadataApplied: (state) => {
      legacy.batch(() => {
        legacy.applySnapshot('sessions', state.sessions)
        legacy.applySnapshot('issues', state.issues)
        legacy.applySnapshot('conversations', state.conversations)
        legacy.applySnapshot('automations', state.automations)
        legacy.applySnapshot('automationRuns', state.automationRuns)
      })
      legacy.setCursor(state.cursor)
    },
  })

  let posture: string = 'cold'
  const offKernel = options.onKernelEvent((event) => {
    if (event.type === 'posture') posture = event.posture
  })
  hub.connect()

  function kernelSnapshot(): Snapshot {
    const out = new Map<string, { revision?: number; digest: string }>()
    for (const record of options.kernel.entities()) {
      out.set(snapshotKey(record.entity, record.entityId), {
        revision: record.revision,
        // Provenance is NOT part of the digest (§2.1) — and it is structurally
        // absent here rather than filtered, because the kernel keeps it beside
        // the value, never inside it.
        digest: contentDigest(record.value),
      })
    }
    return out
  }

  function legacySnapshot(): Snapshot {
    const out = new Map<string, { revision?: number; digest: string }>()
    for (const kind of KINDS) {
      const entity = entityForKind(kind)
      for (const row of legacy.rows(kind)) {
        const id =
          kind === 'sessions'
            ? (row as { sessionId: string }).sessionId
            : (row as { id: string }).id
        out.set(snapshotKey(entity, id), {
          revision: (row as { revision?: number }).revision,
          digest: contentDigest(row),
        })
      }
    }
    return out
  }

  /**
   * `A` IS PRESENCE ONLY, and that is the server's deliberate choice, not a gap
   * here: `sync.feedSlice` returns keys and nothing else — "shipping every row's
   * value to a diagnostic read would make a debugging aid the largest response
   * on the wire".
   *
   * It is exactly enough for the job §2.2 gives `A`: AFFIRMING whether a row is
   * inside this principal's slice. Content and revision comparison happens
   * between `K` and `L`, which both hold whole rows. A digest fabricated here
   * (from a `value` field that does not exist) would compare `undefined` against
   * `undefined` and read as agreement — a third opinion that always agrees is
   * worse than no third opinion.
   */
  async function authoritySnapshot(): Promise<Snapshot> {
    const slice = await options.trpc.sync.feedSlice.query({})
    const out = new Map<string, { revision?: number; digest: string }>()
    for (const row of slice.rows) {
      out.set(snapshotKey(row.entity, row.entityId), { digest: PRESENT })
    }
    return out
  }

  const quiescent = (): string | null => {
    if (posture !== 'live' && posture !== 'stale') return `kernel posture is ${posture}`
    if (hub.connectionHealth().status === 'down') return 'the shadow connection is down'
    return null
  }

  async function sample(): Promise<ShadowReport> {
    const deadline = now() + budget
    let blocked = quiescent()
    while (blocked !== null && now() < deadline) {
      await new Promise((r) => setTimeout(r, 100))
      blocked = quiescent()
    }
    if (blocked !== null) {
      return { status: 'could-not-sample', at: now(), reason: blocked }
    }
    const input: ClassifyInput = {
      kernel: kernelSnapshot(),
      legacy: legacySnapshot(),
      authority: await authoritySnapshot(),
      authorityScoped: options.authorityScoped,
    }
    return { status: 'sampled', at: now(), ...classifySample(input) }
  }

  return {
    sample: async () => {
      const report = await sample()
      options.onReport(report)
      return report
    },
    stop: () => {
      offKernel()
      hub.dispose()
    },
  }
}
