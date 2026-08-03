/**
 * THE MOBILE READ SEAM (POD-332) — thin, and deliberately so.
 *
 * `MobileClientValue` is gone. It was a 55-field adapter object rebuilt inside
 * one `useMemo` with a 27-entry dependency array, which meant every screen
 * re-rendered whenever ANY of those 27 moved, and every store field the phone
 * wanted had to be added to a mobile-local interface first. Screens now read
 * the SAME store and the SAME published slices as the web.
 *
 * What is left here is the small amount of typing and naming that is genuinely
 * mobile's: `MobileTrpc` is the phone's tRPC surface (`PodiumClientApi` plus the
 * hand-written extras Metro can afford), so every store read has to be
 * instantiated at that type. Nothing in this file derives anything — a
 * derivation with two or more consumers belongs in a published slice, and one
 * with a single consumer belongs in its screen.
 *
 * WHAT DOES NOT LIVE HERE, and where it went instead:
 *  - the worklist (sections/rows/pinned/groups) → `worklistSlice` [POD-331]
 *  - machine placement and the see/use/manage verbs → `slices/machines` [§3.1.4]
 *  - superagent threads → `superagentSlice` [POD-330]
 *  - every mutation (rename, snooze, tuck, mark-read, spawn) → store actions
 *  - fatal errors, storage notices, sign-out erase → `./shell`
 */
import { useStore, useStoreSelector } from '@podium/client-core/react'
import type { SocketHub } from '@podium/client-core/socket-transport'
import type { RoutedUiState } from '@podium/client-core/ui-state'
import type { IssueWire, SessionId, SessionMeta } from '@podium/model'
import { useEffect, useState } from 'react'
import { demoEnabled } from './demoData'
import type { MobileTrpc, TranscriptPage } from './trpc'

/** The whole snapshot, typed at the phone's tRPC surface. Use a narrower hook
 *  below when one field will do — this one re-renders on any store change. */
export function useMobileStore() {
  return useStore<MobileTrpc>()
}

export function useTrpc(): MobileTrpc {
  return useStoreSelector<MobileTrpc, MobileTrpc>((s) => s.trpc)
}

/** The app-wide transport hub; terminal views share it instead of opening a
 *  second socket. */
export function useHub(): SocketHub {
  return useStoreSelector<SocketHub, MobileTrpc>((s) => s.hub)
}

export function useSessions(): SessionMeta[] {
  return useStoreSelector<SessionMeta[], MobileTrpc>((s) => s.sessions)
}

export function useIssues(): IssueWire[] {
  return useStoreSelector<IssueWire[], MobileTrpc>((s) => s.issues)
}

/**
 * One issue by id, or undefined.
 *
 * UNDEFINED IS NOT "DELETED" (doc §3.1 ¶2). Under the scoped feed an id can name
 * a row this principal may not see, one that was evicted from their view, or one
 * that simply has not arrived — and a screen must render none of those as a
 * deletion. Callers here show the id inert rather than an error, which is the
 * same choice `resolveIssueEdge`'s `pending` renders on the desktop issue page.
 */
export function useIssue(id: string | undefined): IssueWire | undefined {
  return useStoreSelector<IssueWire | undefined, MobileTrpc>((s) =>
    id === undefined ? undefined : s.issues.find((issue) => issue.id === id),
  )
}

export function useSession(id: SessionId | undefined): SessionMeta | undefined {
  return useStoreSelector<SessionMeta | undefined, MobileTrpc>((s) =>
    id === undefined ? undefined : s.sessions.find((session) => session.sessionId === id),
  )
}

/** ONE UI persistence mechanism: the replica's per-principal ui-state
 *  collection. No screen writes raw AsyncStorage (doc §3.3 / POD-329). */
export function useUiState(): RoutedUiState {
  return useStoreSelector<RoutedUiState, MobileTrpc>((s) => s.uiState)
}

/**
 * Transport liveness, as six mobile surfaces ask for it.
 *
 * NOT A SLICE, and not because it has too few consumers. Connection health is
 * stream-plane: ephemeral, blank offline, no durable row, nothing memoized
 * against an entity snapshot — the same reason presence gets its own publisher
 * (doc §3.4). It is read off the hub, which is where it lives.
 *
 * Demo mode reports connected because there is no socket at all in it: the
 * fixture store is the whole world, and painting an offline banner over a design
 * fixture would be reporting a fact about a server nobody asked it to reach.
 */
export function useConnected(): boolean {
  const hub = useHub()
  const [connected, setConnected] = useState(() => hub.connectionHealth().status !== 'down')
  useEffect(() => hub.onConnectionHealth((health) => setConnected(health.status !== 'down')), [hub])
  return demoEnabled() ? true : connected
}

/** One page of a session transcript, newest-first, as both transcript readers
 *  (session chat, superagent) ask for it. A shared call shape rather than a
 *  derivation — the paging arguments must not drift between the two. */
export function readTranscriptPage(
  trpc: MobileTrpc,
  sessionId: SessionId,
  anchor?: string,
): Promise<TranscriptPage> {
  return trpc.sessions.transcriptRead.query({
    sessionId,
    ...(anchor ? { anchor } : {}),
    direction: 'before',
    limit: 80,
  })
}
