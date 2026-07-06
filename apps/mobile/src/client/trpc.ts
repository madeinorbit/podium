import {
  parseServerOrigin,
  resolveServerConfig,
  type ServerConfig,
} from '@podium/client-core/transport'
import type { SyncChangesSinceResult, TranscriptItem } from '@podium/protocol'
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

export interface MobileTrpc {
  sync: {
    changesSince: QueryProcedure<{ cursor: number | null }, SyncChangesSinceResult>
  }
  sessions: {
    transcriptRead: QueryProcedure<
      { sessionId: string; anchor?: string; direction: 'before' | 'after'; limit: number },
      TranscriptPage
    >
    resumeAndSend: MutationProcedure<{ sessionId: string; text: string; mutationId?: string }>
  }
}

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
