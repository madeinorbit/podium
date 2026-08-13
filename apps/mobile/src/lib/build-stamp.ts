/**
 * THE BUILD STAMP — which server this phone is talking to, and what the two
 * ends are running.
 *
 * A phone can be pointed at a laptop, a tailnet box or a packaged deployment,
 * and nothing on screen used to say which; after a redeploy "is this the new
 * code?" was unanswerable without opening a terminal. So the Pulse tab carries
 * a dim mono stamp naming the host and BOTH versions, because the failure that
 * matters is a mismatch between them.
 *
 * `dev+<sha7>` is the server's own convention (`apps/server/src/build-version.ts`)
 * and is greppable against `git log`; the app side is the Expo build-time
 * `EXPO_PUBLIC_APP_VERSION`, or `dev` when it has none to claim.
 */
import { parseServerVersion } from '@podium/protocol'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useHttpOrigin } from '../client/hooks'
import { appVersion } from './logging'

/** What the last `/version` probe established. */
export type ServerProbe =
  /** No answer yet — the first probe is still out. */
  | { status: 'pending' }
  /** The server answered. `version` is absent when it reported none. */
  | { status: 'ok'; version?: string }
  /** The probe failed. `lastVersion` is what it said the last time it answered. */
  | { status: 'offline'; lastVersion?: string }

/** U+00A0, written as an escape so the source stays greppable and no editor or
 *  formatter can silently turn it back into an ordinary space. */
const NBSP = '\u00A0'

/** `http://ludovico:18787/` → `ludovico:18787`. The scheme never varies in
 *  practice and a full URL does not fit the line. */
export function originHost(httpOrigin: string): string {
  try {
    return new URL(httpOrigin).host || httpOrigin
  } catch {
    return httpOrigin
  }
}

export interface BuildStampInput {
  httpOrigin: string | undefined
  server: ServerProbe
  app: string
}

/**
 * The stamp as its parts, in every state it has.
 *
 * OFFLINE LEADS WITH THE WORD, not the host: an unreachable server is the thing
 * to read first, and the version it last reported is stale by definition, so it
 * is labelled `last` rather than presented as current.
 */
export function buildStampSegments(input: BuildStampInput): string[] {
  const app = `app ${input.app}`
  const origin = input.httpOrigin?.trim()
  if (!origin) return ['not configured', app]

  const host = originHost(origin)
  if (input.server.status === 'ok') return [host, `server ${input.server.version ?? '?'}`, app]
  if (input.server.status === 'pending') return [host, 'server ?', app]
  return input.server.lastVersion
    ? ['offline', `last server ${input.server.lastVersion}`, app]
    : ['offline', 'server ?', app]
}

/** The whole stamp on one line — what a log line or a wide surface wants. */
export function formatBuildStamp(input: BuildStampInput): string {
  return buildStampSegments(input).join(' · ')
}

/**
 * The stamp as the phone renders it: WHERE on the first line, WHAT on the second.
 *
 * ONE LINE DID NOT FIT A REAL HANDSET. It truncated, and the half it ate was the
 * versions — the entire point of the stamp. So the break is placed rather than
 * left to the layout: the host gets its own line and the two versions share the
 * next one, which is also the reading order (where am I pointed / what is it
 * running).
 *
 * Each segment is internally NON-BREAKING, so if the second line is still too
 * wide — a long `dev+<sha>` beside a long app version on a narrow screen — it
 * wraps at a separator rather than splitting a version in half.
 */
export function buildStampLines(input: BuildStampInput): string {
  const [where, ...what] = buildStampSegments(input).map((s) => s.replaceAll(' ', NBSP))
  return what.length === 0 ? where : `${where}\n${what.join(' · ')}`
}

/**
 * Ask a server what it is running. `/version` is the unauthenticated pre-boot
 * probe every client already makes, so this needs no session and no tRPC.
 *
 * Returns undefined when the server is unreachable or answers with something
 * that is not a version document; a reachable server that reports no version
 * comes back as `{}`, which the caller renders as `?` rather than as offline.
 */
export async function probeServerVersion(
  httpOrigin: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ version?: string } | undefined> {
  try {
    const res = await fetchImpl(`${httpOrigin.replace(/\/+$/, '')}/version`)
    if (!res.ok) return undefined
    return { version: parseServerVersion(await res.json()).appVersion }
  } catch {
    return undefined
  }
}

/**
 * The rendered stamp, plus the way to re-probe.
 *
 * CADENCE IS THE CALLER'S. There is no timer here: the stamp probes once on
 * mount and again whenever the screen it sits on refreshes, so a stale reading
 * is never older than the numbers above it, and a backgrounded phone is not
 * waking up to poll a server nobody is looking at.
 */
export function useBuildStamp(): { text: string; reload: () => void } {
  const httpOrigin = useHttpOrigin()
  const [server, setServer] = useState<ServerProbe>({ status: 'pending' })
  // Survives a failed probe so `offline · last server …` has something to name.
  const lastVersion = useRef<string | undefined>(undefined)

  const reload = useCallback(() => {
    if (!httpOrigin) return
    let live = true
    void probeServerVersion(httpOrigin).then((result) => {
      if (!live) return
      if (!result) {
        setServer({ status: 'offline', lastVersion: lastVersion.current })
        return
      }
      lastVersion.current = result.version ?? lastVersion.current
      setServer({ status: 'ok', version: result.version })
    })
    return () => {
      live = false
    }
  }, [httpOrigin])

  useEffect(() => {
    setServer({ status: 'pending' })
    return reload()
  }, [reload])

  return {
    text: buildStampLines({ httpOrigin, server, app: appVersion() }),
    reload: () => {
      reload()
    },
  }
}
