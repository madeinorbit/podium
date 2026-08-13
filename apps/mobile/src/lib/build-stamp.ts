/**
 * THE BUILD STAMP — which server this phone is talking to, and what the two
 * ends are running.
 *
 * A phone can be pointed at a laptop, a tailnet box or a packaged deployment,
 * and nothing on screen used to say which; after a redeploy "is this the new
 * code?" was unanswerable without opening a terminal. So the Pulse tab carries
 * one dim mono line naming the host and BOTH versions side by side, because the
 * failure that matters is a mismatch between them.
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

/** `http://ludovico:18787/` → `ludovico:18787`. The scheme never varies in
 *  practice and a full URL does not fit the line. */
export function originHost(httpOrigin: string): string {
  try {
    return new URL(httpOrigin).host || httpOrigin
  } catch {
    return httpOrigin
  }
}

/**
 * The one line, in every state it has.
 *
 * OFFLINE LEADS WITH THE WORD, not the host: an unreachable server is the thing
 * to read first, and the version it last reported is stale by definition, so it
 * is labelled `last` rather than presented as current.
 */
export function formatBuildStamp(input: {
  httpOrigin: string | undefined
  server: ServerProbe
  app: string
}): string {
  const app = `app ${input.app}`
  const origin = input.httpOrigin?.trim()
  if (!origin) return `not configured · ${app}`

  const host = originHost(origin)
  if (input.server.status === 'ok')
    return `${host} · server ${input.server.version ?? '?'} · ${app}`
  if (input.server.status === 'pending') return `${host} · server ? · ${app}`
  return input.server.lastVersion
    ? `offline · last server ${input.server.lastVersion} · ${app}`
    : `offline · server ? · ${app}`
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
 * The rendered line, plus the way to re-probe.
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
    text: formatBuildStamp({ httpOrigin, server, app: appVersion() }),
    reload: () => {
      reload()
    },
  }
}
