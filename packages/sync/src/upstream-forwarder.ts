import {
  IssueIdField,
  IssueWire,
  RepoIdField,
  SessionIdField,
  UserIdField,
} from '@podium/model'
import type { z } from 'zod'
import { SESSION_COOKIE } from '@podium/protocol'
import { createTRPCClient, httpBatchLink, TRPCClientError } from '@trpc/client'
import { normalizeUpstreamUrl } from './upstream'

/**
 * UpstreamForwarder — the node→hub issue WRITE path (docs/spec/node-hub-issues.md §2.2).
 *
 * Issue mutations targeting a viaHub issue are handed here instead of the local
 * IssueService. The forwarder first tries the hub's tRPC directly (same token/cookie
 * as UpstreamSync); a DEFINITIVE hub rejection (the hub responded with a structured
 * tRPC error — FORBIDDEN, BAD_REQUEST, …) propagates to the caller unqueued, while a
 * transport failure (hub unreachable) durably enqueues the mutation into the
 * `upstream_outbox` table and resolves `{ queued: true }`.
 *
 * The outbox drains SERIALLY (FIFO) with each entry's `mutationId` riding its input —
 * the hub's applied_mutations idempotency (P3) makes replays after a reconnect safe:
 * a mutation the hub already applied returns its recorded result instead of
 * re-running. Drain triggers: enqueue, upstream (re)connect (UpstreamSync's
 * onConnected), and a flat retry timer. The drain loop is PACED — an unref'd yield
 * between entries (transcript-mirror §2.3 amendment: a long queue must never own the
 * loop / starve the systemd watchdog).
 *
 * Poison entries: a drained entry the hub definitively rejects is DROPPED (logged) —
 * retrying it forever would wedge everything queued behind it. A transport failure
 * mid-drain stops the pass (order preserved) and re-arms the flat retry.
 */

export interface UpstreamOutboxStore {
  enqueueUpstreamMutation(row: {
    mutationId: string
    proc: string
    input: string
    queuedAt: number
  }): boolean
  listUpstreamOutbox(): { mutationId: string; proc: string; input: string; attempts: number }[]
  deleteUpstreamMutation(mutationId: string): void
  bumpUpstreamMutationAttempts(mutationId: string): void
}

export interface UpstreamForwarderOptions {
  /** Hub base URL + hub-minted token — the SAME pair UpstreamSync uses. Ignored
   *  when a `call` seam is injected (unit tests). */
  url?: string
  token?: string
  store: UpstreamOutboxStore
  /** Fired whenever the outbox contents changed (enqueue/drain/poison-drop) so the
   *  registry can re-publish issue pendingSync flags. */
  onQueueChanged?: () => void
  /** Fired when a QUEUED mutation is dropped because the hub definitively rejected
   *  it (issue #25): the user's optimistic edit is LOST, and silently logging it
   *  left the overlay showing state the hub refused. The registry surfaces it
   *  (durable podium event + overlay retirement). `input` is the entry's parsed
   *  input (mutationId included); `message` is the hub's rejection message. */
  onPoisoned?: (proc: string, input: Record<string, unknown>, message: string) => void
  /** Yield between drained entries (watchdog pacing rule). */
  paceMs?: number
  /** Flat retry interval while entries remain queued. */
  retryMs?: number
  /** Test seams. */
  call?: (proc: string, input: Record<string, unknown>) => Promise<unknown>
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

const DRAIN_PACE_MS = 25
const RETRY_MS = 5_000

/** The hub RESPONDED with a structured tRPC error (vs. a transport failure): the
 *  mutation was seen and rejected — queuing it for replay would just replay the
 *  rejection. Transport failures (fetch refused/reset/timeout) carry no `data`. */
export function isDefinitiveRejection(err: unknown): boolean {
  return err instanceof TRPCClientError && err.data != null
}

/**
 * The node-side optimistic overlay for a QUEUED mutation (spec §2.2): the fields of
 * the upstream replica entry this proc would change, so the UI reflects the edit
 * immediately; the hub's next delta/snapshot overwrites with truth. Procs whose
 * effect is not representable locally (start/addSession/depAdd/…) return only a marker
 * patch — pendingSync still shows, the value waits for hub truth.
 */
/**
 * The BRANDED id keys an `update` patch can carry, DERIVED from `IssueWire`
 * rather than listed.
 *
 * `input` is an untyped tRPC payload, so every one of these is PARSED with its
 * shared field schema. A blind `as Partial<IssueWire>` over the whole patch
 * would launder a raw string straight into a branded field, which is exactly
 * what the brand exists to prevent.
 *
 * WHY DERIVED. A hand-written list is one `git blame` away from being wrong:
 * add a fifth branded id to the issue vocabulary and a literal list silently
 * stops covering it, so the new key is laundered and nothing fails. This walks
 * `IssueWire.shape` and keeps the keys whose unwrapped field schema IS one of
 * the shared brand fields — INSTANCE identity (`===`), not a name match, so a
 * restated look-alike is not mistaken for the real one. `rearch-audit`'s
 * issue-shapes detector flagged the hand-written version, and it was right to.
 *
 * `machineId` cannot appear here by construction: it is carved out of the flip
 * until POD-318 (ADR 1 Amendment 2 D16.2) and so carries no brand field to match.
 *
 * EXPORTED for its test only: asserting on `IssueWire.shape` proves something
 * about the model, not about this derivation. A mutant that matched brands by
 * CONSTRUCTOR instead of identity — mapping every branded key to whichever brand
 * field happens to be listed first — survived until the test pinned THIS map
 * per key.
 */
const BRAND_FIELDS: readonly z.ZodType[] = [IssueIdField, SessionIdField, UserIdField, RepoIdField]

/**
 * The shared brand field a schema wraps, or undefined.
 *
 * Checks identity at EVERY level rather than only at the innermost, because
 * `ZodBranded` itself exposes `.unwrap()` — a loop that peels until it can peel
 * no further sails straight PAST the brand and lands on the bare `z.string()`,
 * matching nothing. That is not hypothetical: it is what this function did on
 * its first draft, and the per-key identity assertions in
 * `upstream-forwarder.brand-identity.test.ts` are what caught it. The
 * value-preservation tests all PASSED against the broken version, because a
 * derivation that finds nothing passes everything through unchanged.
 */
function brandFieldOf(schema: unknown): z.ZodType | undefined {
  let cur = schema
  for (let i = 0; i < 8; i++) {
    const match = BRAND_FIELDS.find((f) => (f as unknown) === cur)
    if (match) return match
    const c = cur as { unwrap?: () => unknown }
    if (typeof c?.unwrap !== 'function') break
    cur = c.unwrap()
  }
  return undefined
}

export const PATCH_ID_FIELDS: Readonly<Record<string, z.ZodType>> = Object.fromEntries(
  Object.entries(IssueWire.shape).flatMap(([key, field]) => {
    const match = brandFieldOf(field)
    return match ? [[key, match] as const] : []
  }),
)

export function optimisticIssuePatch(
  proc: string,
  input: Record<string, unknown>,
  nowIso: string,
): Partial<IssueWire> {
  switch (proc) {
    case 'update': {
      const raw = { ...((input.patch ?? {}) as Record<string, unknown>) }
      const ids: Partial<IssueWire> = {}
      for (const [key, field] of Object.entries(PATCH_ID_FIELDS)) {
        if (!(key in raw)) continue
        const parsed = field.safeParse(raw[key])
        delete raw[key]
        // A non-string (or otherwise unparseable) id is DROPPED rather than
        // passed through: the optimistic overlay is overwritten by hub truth
        // moments later, so omitting a field is recoverable and forging a
        // branded one is not.
        if (parsed.success) Object.assign(ids, { [key]: parsed.data })
      }
      // Everything left is id-free, so the cast carries no brand.
      const patch = raw as Partial<IssueWire> & { color?: string | null }
      // The mutation input uses null to clear an optional colour, while IssueWire
      // represents "no colour" as absence. Keep the node-side optimistic replica
      // wire-valid instead of briefly exposing color:null to consumers.
      if (patch.color === null) patch.color = undefined
      return { ...patch, ...ids, updatedAt: nowIso }
    }
    case 'close':
      return {
        stage: 'done',
        ...(typeof input.reason === 'string' ? { closedReason: input.reason } : {}),
        updatedAt: nowIso,
      }
    case 'claim':
      // PARSED, not cast — as in the arms below.
      return UserIdField.safeParse(input.assignee).success
        ? { assignee: UserIdField.parse(input.assignee), updatedAt: nowIso }
        : { updatedAt: nowIso }
    case 'setLabels':
      return Array.isArray(input.labels)
        ? { labels: input.labels as string[], updatedAt: nowIso }
        : { updatedAt: nowIso }
    case 'defer':
      return {
        ...(typeof input.until === 'string' ? { deferUntil: input.until } : {}),
        deferred: typeof input.until === 'string',
        updatedAt: nowIso,
      }
    case 'setNeedsHuman':
      return {
        needsHuman: true,
        ...(typeof input.question === 'string' ? { humanQuestion: input.question } : {}),
        // Structured question metadata (issue #53) — mirrored optimistically so
        // the node-side tray can render chips before hub truth arrives. askedAt
        // is hub-stamped; the send time is the honest local approximation.
        ...(Array.isArray(input.options) && input.options.every((o) => typeof o === 'string')
          ? { humanQuestionOptions: input.options as string[] }
          : {}),
        // PARSED, not cast: `input` is an untyped tRPC payload. The brand-only
        // field schema accepts exactly what `typeof === 'string'` accepted, so
        // the wire effect is unchanged and no raw string is laundered.
        ...(SessionIdField.safeParse(input.askedBy).success
          ? { humanQuestionAskedBy: SessionIdField.parse(input.askedBy) }
          : {}),
        humanQuestionAskedAt: nowIso,
        updatedAt: nowIso,
      }
    case 'clearNeedsHuman':
      return { needsHuman: false, updatedAt: nowIso }
    case 'archive':
      return { archived: true, updatedAt: nowIso }
    case 'reparent':
      return {
        // PARSED, not cast — as in the `setNeedsHuman` arm above.
        ...(IssueIdField.safeParse(input.parentId).success
          ? { parentId: IssueIdField.parse(input.parentId) }
          : {}),
        updatedAt: nowIso,
      }
    default:
      // Marker-only: pendingSync shows, the value change waits for hub truth.
      return { updatedAt: nowIso }
  }
}

// optimisticComment was removed with #175: comment bodies no longer ride
// IssueWire, so a queued addComment's optimistic effect is a commentCount bump
// (applied in modules/issues/upstream), not an appended body.

export class UpstreamForwarder {
  private readonly store: UpstreamOutboxStore
  private readonly call: (proc: string, input: Record<string, unknown>) => Promise<unknown>
  private readonly onQueueChanged: (() => void) | undefined
  private readonly onPoisoned:
    | ((proc: string, input: Record<string, unknown>, message: string) => void)
    | undefined
  private readonly paceMs: number
  private readonly retryMs: number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly now: () => number
  private draining = false
  private drainAgain = false
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private stopped = false

  // Test seams (observability without poking privates).
  /** Completed drain passes. */
  drainPasses = 0

  constructor(opts: UpstreamForwarderOptions) {
    this.store = opts.store
    this.onQueueChanged = opts.onQueueChanged
    this.onPoisoned = opts.onPoisoned
    this.paceMs = opts.paceMs ?? DRAIN_PACE_MS
    this.retryMs = opts.retryMs ?? RETRY_MS
    this.sleep =
      opts.sleep ??
      ((ms) =>
        new Promise((resolve) => {
          const t = setTimeout(resolve, ms)
          t.unref?.()
        }))
    this.now = opts.now ?? Date.now
    if (opts.call) {
      this.call = opts.call
    } else {
      if (!opts.url || !opts.token)
        throw new Error('UpstreamForwarder needs url+token or a call seam')
      const { http } = normalizeUpstreamUrl(opts.url)
      const cookie = `${SESSION_COOKIE}=${encodeURIComponent(opts.token)}`
      // Untyped client cast to a narrow structural shape (the same pattern
      // UpstreamSync/@podium/issue-client use): this package must depend only on
      // @podium/protocol, never the app's actual AppRouter type.
      const client = createTRPCClient({
        links: [httpBatchLink({ url: `${http}/trpc`, headers: () => ({ cookie }) })],
      }) as unknown as {
        issues: Record<string, { mutate: (i: unknown) => Promise<unknown> } | undefined>
      }
      this.call = (proc, input) => {
        const m = client.issues[proc]
        if (!m) return Promise.reject(new Error(`unknown issues proc '${proc}'`))
        return m.mutate(input)
      }
    }
  }

  /** The queued entries (pendingSync derivation + tests). */
  entries(): { mutationId: string; proc: string; input: string; attempts: number }[] {
    return this.store.listUpstreamOutbox()
  }

  /**
   * Forward one issue mutation to the hub NOW; on transport failure, durably queue
   * it and resolve `{ queued: true }`. `input.mutationId` must be set (the registry
   * mints one when the caller didn't) — it is both the outbox PK and the hub-side
   * idempotency key.
   */
  async forward(proc: string, input: Record<string, unknown>): Promise<unknown> {
    const mutationId = input.mutationId
    if (typeof mutationId !== 'string' || !mutationId) {
      throw new Error('forwarded issue mutations must carry a mutationId')
    }
    try {
      return await this.call(proc, input)
    } catch (err) {
      if (isDefinitiveRejection(err)) throw err
      this.store.enqueueUpstreamMutation({
        mutationId,
        proc,
        input: JSON.stringify(input),
        queuedAt: this.now(),
      })
      this.onQueueChanged?.()
      // Spec drain triggers include enqueue — the hub just failed, so this pass
      // will typically stop immediately and re-arm the flat retry, but a race
      // where the hub is back already resolves the queue right here.
      void this.drain()
      return { queued: true }
    }
  }

  /**
   * Drain the outbox: serial, FIFO, paced (a yield between entries). A transport
   * failure stops the pass — order is preserved, the flat retry re-enters. A
   * definitive hub rejection drops the poison entry and continues.
   */
  async drain(): Promise<void> {
    if (this.stopped) return
    if (this.draining) {
      this.drainAgain = true
      return
    }
    this.draining = true
    try {
      for (const entry of this.store.listUpstreamOutbox()) {
        if (this.stopped) return
        let input: Record<string, unknown>
        try {
          input = JSON.parse(entry.input) as Record<string, unknown>
        } catch {
          console.warn(`[podium:upstream] dropping corrupt outbox entry ${entry.mutationId}`)
          this.store.deleteUpstreamMutation(entry.mutationId)
          this.onQueueChanged?.()
          continue
        }
        try {
          // Replays carry the entry's OWN mutationId — the hub's idempotency layer
          // turns an already-applied replay into its recorded result (invariant 2).
          await this.call(entry.proc, { ...input, mutationId: entry.mutationId })
          this.store.deleteUpstreamMutation(entry.mutationId)
          this.onQueueChanged?.()
        } catch (err) {
          if (isDefinitiveRejection(err)) {
            console.warn(
              `[podium:upstream] hub rejected queued issue mutation ${entry.mutationId} (${entry.proc}) — dropping:`,
              (err as Error).message,
            )
            this.store.deleteUpstreamMutation(entry.mutationId)
            // Surface the loss BEFORE the queue-changed republish so the retired
            // overlay and the rejection marker land in one wire update (#25).
            try {
              this.onPoisoned?.(
                entry.proc,
                { ...input, mutationId: entry.mutationId },
                (err as Error).message,
              )
            } catch {}
            this.onQueueChanged?.()
          } else {
            this.store.bumpUpstreamMutationAttempts(entry.mutationId)
            this.scheduleRetry()
            return
          }
        }
        // Watchdog pacing rule: yield between drained entries so a deep queue
        // never owns the loop (transcript-mirror §2.3 amendment).
        await this.sleep(this.paceMs)
      }
    } finally {
      this.draining = false
      this.drainPasses += 1
      if (this.drainAgain) {
        this.drainAgain = false
        void this.drain()
      } else if (this.store.listUpstreamOutbox().length > 0) {
        this.scheduleRetry()
      }
    }
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      void this.drain()
    }, this.retryMs)
    this.retryTimer.unref?.()
  }

  stop(): void {
    this.stopped = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = undefined
  }
}
