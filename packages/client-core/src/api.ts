/**
 * Structural client API seam (arch-v2 P3, issue #192): the slice of the
 * server's tRPC router that the SHARED store/actions layer calls. Hand-written
 * — packages must never import apps (boundary rule 4), so client-core cannot
 * see the server's AppRouter type even type-only. Instead each app hands its
 * own typed client in:
 *
 *  - apps/web passes its AppRouter-typed tRPC client (assignability to this
 *    interface is checked by web's tsc, so drift fails the web typecheck);
 *  - apps/mobile's hand-written MobileTrpc intersects this interface with its
 *    mobile-only extras.
 *
 * The store is generic over `TApi extends PodiumClientApi`, so an app keeps
 * its own richer procedure types on `store.trpc` while the shared code only
 * relies on what's declared here. Outputs are typed only where the shared
 * store reads them; inputs match exactly what it sends.
 */

import type { AgentKind, GitDiscoveryDiagnosticWire, GitRepositoryWire, SessionId, WorkState } from '@podium/model'
import type { SyncChangesSinceResult } from '@podium/protocol'
import type { PodiumSettings } from '@podium/runtime'
import type { PinKind, PinState } from './viewmodels/types'

export interface ApiQuery<I, O> {
  query(input: I): Promise<O>
}

export interface ApiMutation<I, O = unknown> {
  mutate(input: I): Promise<O>
}

/** Outboxed mutations replay with a stable id so the server dedupes. */
type WithMutationId<T> = T & { mutationId?: string }

export interface PodiumClientApi {
  sync: {
    changesSince: ApiQuery<{ cursor: number | null }, SyncChangesSinceResult>
  }
  discovery: {
    refreshRepos: ApiMutation<
      void,
      { repositories: GitRepositoryWire[]; diagnostics: GitDiscoveryDiagnosticWire[] }
    >
  }
  sessions: {
    create: ApiMutation<
      {
        sessionId?: string
        agentKind?: AgentKind
        cwd: string
        title?: string
        issueId?: string
        draftIssue?: { repoPath: string; issueId?: string }
        machineId?: string
        mutationId?: string
      },
      { sessionId: SessionId }
    >
    resumeAndSend: ApiMutation<WithMutationId<{ sessionId: SessionId; text: string }>>
    rename: ApiMutation<WithMutationId<{ sessionId: SessionId; name: string }>>
    setArchived: ApiMutation<WithMutationId<{ sessionId: SessionId; archived: boolean }>>
    setWorkState: ApiMutation<WithMutationId<{ sessionId: SessionId; workState: WorkState | null }>>
    markRead: ApiMutation<WithMutationId<{ sessionId: SessionId }>>
    markUnread: ApiMutation<WithMutationId<{ sessionId: SessionId }>>
    kill: ApiMutation<{ sessionId: SessionId }>
    continue: ApiMutation<{ sessionId: SessionId }>
    hibernate: ApiMutation<{ sessionId: SessionId }>
    resurrect: ApiMutation<{ sessionId: SessionId }, { ok: boolean; reason?: string }>
  }
  snoozes: {
    set: ApiMutation<WithMutationId<{ sessionId: SessionId; until: string | null }>>
    clear: ApiMutation<WithMutationId<{ sessionId: SessionId }>>
  }
  issues: {
    markRead: ApiMutation<WithMutationId<{ id: string }>>
    markUnread: ApiMutation<WithMutationId<{ id: string }>>
    /** Tuck-away dismissal (POD-333) — server-side, global, outboxed. */
    setTucked: ApiMutation<WithMutationId<{ id: string; tucked: boolean }>>
  }
  pins: {
    list: ApiQuery<void, PinState>
    set: ApiMutation<{ kind: PinKind; id: string; pinned: boolean }, PinState>
  }
  tabs: {
    listOrders: ApiQuery<void, Record<string, string[]>>
    setOrder: ApiMutation<{ worktree: string; sessionIds: string[] }, Record<string, string[]>>
  }
  files: {
    read: ApiQuery<
      {
        sessionId?: string
        machineId?: string
        root?: string
        // Artifact-snapshot reads ([spec:SP-0fc9] #441).
        issueId?: string
        artifactId?: string
        path: string
      },
      unknown
    >
    write: ApiMutation<{
      sessionId?: string
      machineId?: string
      root?: string
      path: string
      content: string
      baseHash?: string
    }>
    list: ApiQuery<{ machineId?: string; root: string; path?: string }, unknown>
  }
  /** Git dock panel [POD-114] — raw output of fixed read-only repo ops. */
  git: {
    status: ApiQuery<{ machineId?: string; root: string }, { ok: boolean; output: string }>
    log: ApiQuery<{ machineId?: string; root: string }, { ok: boolean; output: string }>
    diffFile: ApiQuery<
      { machineId?: string; root: string; path: string },
      { ok: boolean; output: string }
    >
  }
  settings: {
    get: ApiQuery<void, PodiumSettings>
    set: ApiMutation<PodiumSettings, PodiumSettings>
  }
  superagent: {
    startBtw: ApiMutation<{ sessionId: SessionId }>
    sendTurn: ApiMutation<
      { threadId: string; text: string },
      { threadId: string; podiumSessionId?: SessionId }
    >
  }
}
