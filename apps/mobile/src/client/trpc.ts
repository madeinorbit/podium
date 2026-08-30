import type { PodiumClientApi } from '@podium/client-core/api'
import {
  parseServerOrigin,
  resolveServerConfig,
  type ServerConfig,
} from '@podium/client-core/transport'
import type { AskAnswerChoice } from '@podium/client-core/viewmodels'
import type {
  IssueColorSlot,
  IssueStage,
  IssueType,
  IssueWire,
  MutationId,
  SessionId,
  ThreadId,
  TranscriptItem,
} from '@podium/model'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import { Platform } from 'react-native'
import { MobileAuthExpiredError } from './auth'

interface QueryProcedure<I, O> {
  query(input: I): Promise<O>
}

interface MutationProcedure<I, O = unknown> {
  mutate(input: I): Promise<O>
}

export interface TranscriptPage {
  items: TranscriptItem[]
  head?: string
  tail?: string
  hasMore: boolean
}

/**
 * Mobile-only procedures beyond the shared PodiumClientApi seam (transcript
 * paging, ask-user answers, superagent turn control, issue CRUD). Hand-written
 * because importing the server's AppRouter type would pull the whole server
 * into the Metro graph; kept narrow and in one place so drift is easy to audit.
 * Everything the SHARED store/actions layer calls lives in PodiumClientApi
 * (@podium/client-core/api) — the intersection below is the full client type.
 */
interface MobileTrpcExtras {
  sessions: {
    transcriptRead: QueryProcedure<
      { sessionId: SessionId; anchor?: string; direction: 'before' | 'after'; limit: number },
      TranscriptPage
    >
    sendText: MutationProcedure<{ sessionId: SessionId; text: string; mutationId?: MutationId }>
    /**
     * Bytes in, an absolute path on the session's machine out — the one route a
     * prompt has to carry a screenshot, a photo or a document (POD-1203).
     *
     * NO `mutationId`: two uploads are two daemon round-trips and must never be
     * deduped into one. The uploaded file inherits its session's owner and
     * grants like every other child of a session (doc §3.1.2), so the payload
     * carries no actor and no origin — `machineId` is only the fallback target
     * for a session that does not exist yet.
     */
    uploadImage: MutationProcedure<
      {
        sessionId: SessionId
        filename: string
        mimeType: string
        dataBase64: string
        machineId?: string
      },
      { path: string; error?: string }
    >
    answerAskUserQuestion: MutationProcedure<
      {
        sessionId: SessionId
        skip?: true
        choices?: AskAnswerChoice[]
      },
      /** `ok:false` means NOTHING was typed — the menu is still on screen and
       *  the card must say so rather than settle into "sent" (POD-770). */
      { ok: boolean; reason?: string }
    >
    interrupt: MutationProcedure<
      { sessionId: SessionId; messageId?: string },
      { ok?: boolean; reason?: string }
    >
  }
  messages: {
    ledger: QueryProcedure<{ sessionId: SessionId; limit: number }, unknown[]>
    cancel: MutationProcedure<{ id: string }>
  }
  superagent: {
    // THE SHADOW TYPES ARE GONE (POD-332, audit item `superagent-shadow-types`).
    // `listThreads` and `history` were declared here over two mobile-local row
    // interfaces. `listThreads` is served by the shared PodiumClientApi seam and
    // answers `SuperThreadView[]` — the type the superagent SLICE publishes — so
    // the phone and the desktop render one thread shape. `history` is deleted
    // outright rather than re-typed: it is the FROZEN legacy buffer, and this
    // app never called it (see SuperagentScreen for why folding it back
    // in is a trap). Only turn control is mobile's own.
    interruptTurn: MutationProcedure<{ threadId: ThreadId }>
    clear: MutationProcedure<{ threadId: ThreadId }>
  }
  issues: {
    get: QueryProcedure<{ id: string }, IssueWire | undefined>
    create: MutationProcedure<
      {
        repoPath: string
        title: string
        description?: string
        priority?: number
        type?: IssueType
        startNow: boolean
        mutationId?: MutationId
      },
      IssueWire
    >
    /** Spawn the issue's default agent on it (issue-as-workspace). */
    start: MutationProcedure<{ id: string; agentKind?: string }, IssueWire>
    /**
     * Put ANOTHER agent into an already-started issue's worktree [POD-724].
     *
     * Not the same call as `start`, and the split is not cosmetic: `start` is
     * what creates the branch and the checkout, so sending it at an issue that
     * already has one is how you get a second worktree for one task. The phone
     * needs both because the mission screen can now launch an agent from inside
     * the conversation, where the task is usually already running.
     */
    addSession: MutationProcedure<{ id: string; agentKind?: string }, IssueWire>
    /** Operator-only: accept an agent proposal into the backlog [spec:SP-6144]. */
    promote: MutationProcedure<{ id: string }, IssueWire>
    /** Close an issue — the server writes stage `done` + the closure reason. */
    close: MutationProcedure<{ id: string; reason?: string; mutationId?: MutationId }, IssueWire>
    update: MutationProcedure<{
      id: string
      patch: {
        title?: string
        description?: string
        stage?: IssueStage
        archived?: boolean
        priority?: number
        type?: IssueType
        notes?: string
        /** Desktop sidebar parity — pin floats into the Pinned band. */
        pinned?: boolean
        /** Manual order key (POD-168); lexicographic ASC within a band. */
        sortKey?: string
        /** The issue's palette slot, or `null` to clear it back to the neutral
         *  slate flow [POD-724]. The colour channel carries a task's identity
         *  through every row, header and pane on both platforms, and it used to
         *  be settable only at the desk. */
        color?: IssueColorSlot | null
      }
      mutationId?: MutationId
    }>
    addComment: MutationProcedure<{
      id: string
      author: string
      body: string
      mutationId?: MutationId
    }>
    /** Toggle one agent-published todo; the positional API is 1-based. */
    panelApply: MutationProcedure<
      { id: string; op: 'todo-done' | 'todo-undone'; index: number },
      IssueWire
    >
    /** Mark a task-owned human question resolved. */
    clearNeedsHuman: MutationProcedure<{ id: string }>
    /** Acknowledge a finished task — removes its card and board row. */
    archive: MutationProcedure<{ id: string }>
  }
  repos: {
    /** Flat list of registered repo root paths. */
    list: QueryProcedure<void, string[]>
  }
}

export type MobileTrpc = PodiumClientApi & MobileTrpcExtras

declare const process: { env?: Record<string, string | undefined> } | undefined

let activeRuntimeConfig: ServerConfig | undefined
let activeRuntimeBearer: string | null = null

export function envServer(): string | undefined {
  if (typeof process === 'undefined') return undefined
  return process.env?.EXPO_PUBLIC_PODIUM_SERVER
}

export function readServerConfig(): ServerConfig {
  if (activeRuntimeConfig) return activeRuntimeConfig
  const injected = (globalThis as { __PODIUM_SERVER__?: string }).__PODIUM_SERVER__ ?? envServer()
  // A MISSING `location` IS THE NATIVE CASE, not an impossible one (POD-2055 F4).
  // React Native sets `global.window = global`, so `typeof window` is `'object'`
  // on a phone and the old guard fell through to `window.location.search` — a
  // TypeError on the first line of the app's boot, invisible to this repo's
  // mobile lane because it runs react-native-web inside happy-dom. On device the
  // injected global and EXPO_PUBLIC_PODIUM_SERVER are the only config paths
  // there are, which is what the branch below already implements.
  //
  // `typeof` first and always: `window` is an unbound identifier where it does
  // not exist, and optional chaining does not save a ReferenceError.
  const location =
    typeof window === 'undefined'
      ? undefined
      : (window as { location?: Location | undefined }).location
  if (location == null) {
    const parsed = injected ? parseServerOrigin(injected) : null
    if (parsed) return { ...parsed, override: true }
    throw new Error('native server profile has not been selected')
  }
  // Web sessions are page-origin cookie sessions. Only the page's explicit
  // ?server override may redirect them; native build-time injection is ignored.
  //
  // Through the narrowed `location` above rather than `window.location`: the
  // early return has already established it is present, and reaching for the
  // property a second time is the exact spelling that throws on a device.
  return resolveServerConfig(location)
}

export function setActiveServerRuntime(
  config: ServerConfig | undefined,
  bearer: string | null,
): void {
  activeRuntimeConfig = config
  activeRuntimeBearer = bearer
}

export function activeServerHttpOrigin(): string | undefined {
  try {
    return readServerConfig().httpOrigin
  } catch {
    return undefined
  }
}

export function activeServerBearer(): string | null {
  return activeRuntimeBearer
}

export function bearerHeaders(bearer: string | null, headers?: HeadersInit): Headers {
  const result = new Headers(headers)
  if (bearer) result.set('Authorization', `Bearer ${bearer}`)
  return result
}

export async function fetchMobileTransport(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  bearer: string | null,
  onAuthExpired?: (error: MobileAuthExpiredError) => void,
): Promise<Response> {
  const response = await fetch(input, {
    ...init,
    credentials: Platform.OS === 'web' ? 'include' : 'omit',
    headers: bearerHeaders(bearer, init?.headers),
  })
  if (bearer && response.status === 401) {
    onAuthExpired?.(new MobileAuthExpiredError())
  }
  return response
}

export function makeMobileTrpc(
  httpOrigin: string,
  bearer: string | null = null,
  onAuthExpired?: (error: MobileAuthExpiredError) => void,
): MobileTrpc {
  return createTRPCClient<any>({
    links: [
      httpBatchLink({
        url: httpOrigin + '/trpc',
        fetch: (url, opts) => fetchMobileTransport(url, opts, bearer, onAuthExpired),
      }),
    ],
  }) as unknown as MobileTrpc
}
