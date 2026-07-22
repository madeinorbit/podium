import type { PodiumClientApi } from '@podium/client-core/api'
import {
  parseServerOrigin,
  resolveServerConfig,
  type ServerConfig,
} from '@podium/client-core/transport'
import type { IssueStage, IssueType, IssueWire, TranscriptItem } from '@podium/protocol'
import { WIRE_VERSION } from '@podium/protocol'
import { createTRPCClient, httpBatchLink } from '@trpc/client'

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

/** One message of a superagent thread, as stored server-side. */
export interface SuperagentMessage {
  id: number
  role: 'user' | 'assistant' | 'tool' | 'system'
  content: string
  toolName?: string
  createdAt: string
}

export interface SuperagentThread {
  id: string
  kind: 'global' | 'btw' | 'concierge'
  originSessionId?: string
  repoPath?: string
  title?: string
  podiumSessionId?: string
  createdAt: string
  updatedAt: string
  archived: boolean
}

/**
 * Mobile-only procedures beyond the shared PodiumClientApi seam (transcript
 * paging, ask-user answers, superagent threads, issue CRUD). Hand-written
 * because importing the server's AppRouter type would pull the whole server
 * into the Metro graph; kept narrow and in one place so drift is easy to audit.
 * Everything the SHARED store/actions layer calls lives in PodiumClientApi
 * (@podium/client-core/api) — the intersection below is the full client type.
 */
interface MobileTrpcExtras {
  sessions: {
    transcriptRead: QueryProcedure<
      { sessionId: string; anchor?: string; direction: 'before' | 'after'; limit: number },
      TranscriptPage
    >
    sendText: MutationProcedure<{ sessionId: string; text: string; mutationId?: string }>
    answerAskUserQuestion: MutationProcedure<{
      sessionId: string
      choices: { optionIndices: number[] }[]
    }>
  }
  superagent: {
    listThreads: QueryProcedure<void, SuperagentThread[]>
    history: QueryProcedure<{ threadId: string }, SuperagentMessage[]>
    // sendTurn + startBtw are served by the shared PodiumClientApi seam.
    interruptTurn: MutationProcedure<{ threadId: string }>
    clear: MutationProcedure<{ threadId: string }>
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
        mutationId?: string
      },
      IssueWire
    >
    /** Spawn the issue's default agent on it (issue-as-workspace). */
    start: MutationProcedure<{ id: string; agentKind?: string }, IssueWire>
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
      }
      mutationId?: string
    }>
    addComment: MutationProcedure<{
      id: string
      author: string
      body: string
      mutationId?: string
    }>
    /** Quiet-dismiss a humanQuestion card (the tray's resolve ✓). */
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

function envServer(): string | undefined {
  if (typeof process === 'undefined') return undefined
  return process.env?.EXPO_PUBLIC_PODIUM_SERVER
}

export function readServerConfig(): ServerConfig {
  const injected = (globalThis as { __PODIUM_SERVER__?: string }).__PODIUM_SERVER__ ?? envServer()
  if (typeof window === 'undefined') {
    const parsed = injected ? parseServerOrigin(injected) : null
    if (parsed) return { ...parsed, override: true }
    return {
      wsClientUrl: 'ws://127.0.0.1:18787/client?v=' + WIRE_VERSION,
      httpOrigin: 'http://127.0.0.1:18787',
      override: false,
    }
  }
  return resolveServerConfig(window.location, injected)
}

export function makeMobileTrpc(httpOrigin: string): MobileTrpc {
  return createTRPCClient<any>({
    links: [
      httpBatchLink({
        url: httpOrigin + '/trpc',
        fetch: (url, opts) => fetch(url, { ...opts, credentials: 'include' }),
      }),
    ],
  }) as unknown as MobileTrpc
}
