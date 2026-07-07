import { randomUUID } from 'node:crypto'
import type { IssueWire } from '@podium/protocol'
import { SCOPED_TARGET } from '../../issue-authz'
import type { SessionStore } from '../../store'
import { optimisticComment, optimisticIssuePatch } from '../../upstream-forwarder'

/** The narrow forwarder seam the upstream-issue mirror needs (UpstreamForwarder
 *  implements it; kept minimal so relay tests can stub the write path without a hub). */
export interface IssueUpstreamForwarder {
  forward(proc: string, input: Record<string, unknown>): Promise<unknown>
  entries(): { mutationId: string; proc: string; input: string; attempts: number }[]
}

export interface UpstreamIssuesDeps {
  /** Durable event append (issue.upstream_rejected). */
  store: Pick<SessionStore, 'appendEvent'>
  now(): number
  /** True when `id` is a LOCAL issue (collision guard at ingest). Guarded with `?.`
   *  by the caller — safe before IssueService is constructed. */
  localIssueExists(id: string): boolean
  /** Re-publish the full issue list (oplog + split fan-out) — the registry's
   *  publishIssues(safeIssuesList()) path. */
  publish(): void
  /** Hub reachability flag (owned by the registry until the sessions peel). */
  upstreamStale(): boolean
}

/**
 * Hub-issue mirror + write forwarding (docs/spec/node-hub-issues.md).
 *
 * Hub issues merge into the node's issue WIRE only (issuesChanged / metadataDelta /
 * changesSince) — never into IssueService's store or derived logic (§2.1: ready/
 * blocked/deps arrive hub-computed on the wire). Writes targeting them forward to
 * the hub through the durable outbox (§2.2); pendingSync overlays keep the UI
 * truthful while an edit is queued, and hub truth always overwrites (P6a: the
 * replica never argues).
 */
export class UpstreamIssuesService {
  private readonly upstreamIssues = new Map<string, IssueWire>()
  /** Optimistic overlays for QUEUED forwarded mutations, keyed by issue id. Merged
   *  at read time; dropped when hub truth arrives AND the outbox no longer holds an
   *  entry for the issue (so an unrelated hub push can't wipe a pending edit). */
  private readonly upstreamIssuePatches = new Map<string, Partial<IssueWire>>()
  private upstreamForwarder: IssueUpstreamForwarder | undefined

  constructor(private readonly deps: UpstreamIssuesDeps) {}

  setForwarder(forwarder: IssueUpstreamForwarder): void {
    this.upstreamForwarder = forwarder
  }

  /** True when `id` is a hub-mirrored issue — the router's forwarding-detection key. */
  isUpstreamIssue(id: string): boolean {
    return this.upstreamIssues.has(id)
  }

  /** repoPaths that exist among hub issues — issues.create's "hub-only repo" reject
   *  check (spec §2.2: create stays local; a hub-only repoPath is detectable here). */
  repoPaths(): Set<string> {
    return new Set([...this.upstreamIssues.values()].map((i) => i.repoPath))
  }

  /** Re-publish when a staleness flip must reach clients — only when there is
   *  anything mirrored (mirrors the sessions/conversations posture). */
  rebroadcastUpstream(): void {
    if (this.upstreamIssues.size > 0) this.deps.publish()
  }

  /**
   * Replace the mirrored issue list with the hub's truth (UpstreamSync push).
   * Entries are stamped `viaHub` at ingest. Id collisions with a LOCAL issue are
   * impossible by construction (`iss_<uuid>`) but guarded anyway: the local issue
   * wins and the anomaly is logged (spec §2.1). Hub truth arriving also retires
   * optimistic overlays whose outbox entries have drained — the replica never argues.
   */
  setUpstreamIssues(list: IssueWire[]): void {
    this.upstreamIssues.clear()
    for (const i of list) {
      if (this.deps.localIssueExists(i.id)) {
        console.warn(
          `[podium:upstream] hub issue id collides with a local issue — local wins: ${i.id}`,
        )
        continue
      }
      this.upstreamIssues.set(i.id, { ...i, viaHub: true })
    }
    const stillQueued = this.pendingUpstreamTargets()
    for (const id of [...this.upstreamIssuePatches.keys()]) {
      if (!stillQueued.has(id)) this.upstreamIssuePatches.delete(id)
    }
    this.deps.publish()
  }

  /** Issue ids with at least one mutation still queued in the upstream outbox. */
  private pendingUpstreamTargets(): Set<string> {
    const out = new Set<string>()
    if (!this.upstreamForwarder) return out
    for (const e of this.upstreamForwarder.entries()) {
      try {
        const target = SCOPED_TARGET[e.proc]?.(JSON.parse(e.input) as Record<string, unknown>)
        if (typeof target === 'string') out.add(target)
      } catch {
        // corrupt input JSON — the forwarder drops it on its next drain pass
      }
    }
    return out
  }

  /** The mirrored issues as served: optimistic overlay + pendingSync while queued,
   *  upstreamStale applied at read time (same posture as sessions). */
  private upstreamIssuesList(): IssueWire[] {
    const stale = this.deps.upstreamStale()
    return [...this.upstreamIssues.values()].map((i) => {
      const patch = this.upstreamIssuePatches.get(i.id)
      const merged = patch ? { ...i, ...patch, id: i.id } : i
      if (!patch && !stale) return merged
      return {
        ...merged,
        ...(patch ? { pendingSync: true } : {}),
        ...(stale ? { upstreamStale: true } : {}),
      }
    })
  }

  /** Local ∪ upstream issues — the single union seam every issue wire path uses
   *  (attach snapshot, issuesChanged fan-out, changesSince). Local wins collisions. */
  withUpstreamIssues(local: IssueWire[]): IssueWire[] {
    if (this.upstreamIssues.size === 0) return local
    const localIds = new Set(local.map((i) => i.id))
    return [...local, ...this.upstreamIssuesList().filter((i) => !localIds.has(i.id))]
  }

  /**
   * Forward one issue mutation to the hub (router hands viaHub targets here instead
   * of IssueService, spec §2.2). Ensures a mutationId (outbox PK + hub idempotency
   * key); when the hub is unreachable the result is `{ queued: true }` and the
   * upstream replica entry is optimistically patched (pendingSync) so the UI
   * reflects the edit immediately.
   */
  async forwardIssueMutation(proc: string, input: Record<string, unknown>): Promise<unknown> {
    const forwarder = this.upstreamForwarder
    if (!forwarder) {
      throw new Error('issue is managed via the hub, but no upstream is configured')
    }
    const mutationId =
      typeof input.mutationId === 'string' && input.mutationId ? input.mutationId : randomUUID()
    const payload = { ...input, mutationId }
    const result = await forwarder.forward(proc, payload)
    if ((result as { queued?: boolean } | null)?.queued === true) {
      const target = SCOPED_TARGET[proc]?.(payload)
      if (typeof target === 'string') this.applyUpstreamOptimisticPatch(target, proc, payload)
    }
    return result
  }

  /** Merge a queued mutation's optimistic effect into the issue's overlay and
   *  re-publish so pendingSync (and the patched value) hit the wire immediately. */
  private applyUpstreamOptimisticPatch(
    issueId: string,
    proc: string,
    input: Record<string, unknown>,
  ): void {
    if (!this.upstreamIssues.has(issueId)) return
    const nowIso = new Date(this.deps.now()).toISOString()
    const prior = this.upstreamIssuePatches.get(issueId) ?? {}
    const patch = { ...prior, ...optimisticIssuePatch(proc, input, nowIso) }
    if (proc === 'addComment') {
      const base = prior.comments ?? this.upstreamIssues.get(issueId)?.comments ?? []
      patch.comments = [...base, optimisticComment(input, nowIso)]
    }
    this.upstreamIssuePatches.set(issueId, patch)
    this.deps.publish()
  }

  /**
   * A QUEUED forwarded mutation was dropped because the hub definitively rejected
   * it (issue #25). The user's optimistic edit is LOST — surface it instead of a
   * log line: retire the optimistic overlay NOW (keeping it would show state the
   * hub refused), record a durable `issue.upstream_rejected` podium event, and
   * flag the mirrored issue needsHuman (as an overlay — hub truth overwrites on
   * its next push, but the durable event keeps the loss auditable). Wired as the
   * forwarder's onPoisoned.
   */
  mutationRejected(proc: string, input: Record<string, unknown>, message: string): void {
    const target = SCOPED_TARGET[proc]?.(input)
    const mutationId = typeof input.mutationId === 'string' ? input.mutationId : null
    if (typeof target === 'string') {
      this.upstreamIssuePatches.delete(target)
      const issue = this.upstreamIssues.get(target)
      try {
        this.deps.store.appendEvent({
          ts: new Date(this.deps.now()).toISOString(),
          kind: 'issue.upstream_rejected',
          subject: target,
          repoPath: issue?.repoPath ?? null,
          payload: {
            proc,
            message,
            ...(mutationId ? { mutationId } : {}),
            ...(issue ? { seq: issue.seq } : {}),
          },
        })
      } catch {}
      if (issue) {
        this.upstreamIssuePatches.set(target, {
          needsHuman: true,
          humanQuestion: `hub rejected queued '${proc}': ${message}`,
        })
      }
    }
    this.deps.publish()
  }

  /** Outbox contents changed (enqueue/drain/poison-drop) — recompute pendingSync
   *  overlays and re-publish. Wired as the forwarder's onQueueChanged. */
  outboxChanged(): void {
    const stillQueued = this.pendingUpstreamTargets()
    let changed = false
    for (const id of [...this.upstreamIssuePatches.keys()]) {
      // Keep the overlay VALUE until hub truth arrives (setUpstreamIssues) — only
      // pendingSync derivation lives here; dropping the value on drain-success
      // would flash the pre-edit state before the hub's delta lands.
      if (!stillQueued.has(id) && !this.upstreamIssues.has(id)) {
        this.upstreamIssuePatches.delete(id)
        changed = true
      }
    }
    if (changed || this.upstreamIssues.size > 0) this.deps.publish()
  }
}
