/**
 * MOBILE HANDOFF — the two surfaces that hand a desk session to a phone.
 *
 * `/mobile` is the Expo app this server already serves (`static-web.ts`,
 * POD-102) and the same URL Settings → Connected devices puts behind its
 * open-mode QR. Both surfaces here point at exactly that: no second URL
 * vocabulary, and nothing minted — a promotional code that expires is a support
 * ticket.
 *
 * The QR carries the PUBLIC origin when the instance has one configured, not
 * `location.origin`: a phone cannot resolve the `localhost` address the
 * operator's browser is on, and a code that resolves to nothing is worse than
 * no code at all.
 *
 * SPLIT HOSTING (PDM-34): where the UI is a separate origin, the public URL is
 * the API and has no `/mobile` page of its own — it only redirects to one. The
 * QR reads `appUrl` and points the phone at the app host in ONE hop. The
 * redirect stays as the fallback for clients too old to know about `appUrl`;
 * this is about not spending a round trip, and not showing a person an address
 * that is not where they end up.
 */

import { MOBILE_PROMO_DISMISSED_KEY } from '@podium/client-core/ui-state'
import { useEffect, useState } from 'react'
import { type Store, useReplicaIssues } from '@/app/store'
import { usePersistedUiState } from '@/lib/use-persisted-ui-state'

/** The phone entry point on this instance — the Expo app, not the desktop shell. */
export const MOBILE_PATH = '/mobile'

/** Absolute `/mobile` URL on `origin`, with no query and no fragment. */
export function mobileHandoffUrl(origin: string): string {
  const url = new URL(MOBILE_PATH, origin)
  url.search = ''
  url.hash = ''
  return url.href
}

/**
 * The URL a phone should open. Starts on this window's origin so the surfaces
 * can render immediately, and upgrades when the probe answers to the app host
 * if the deployment has one, else the configured public URL — the shape
 * Settings → Network validates, and the only address that is reachable from off
 * this machine.
 */
export function useMobileHandoffUrl(trpc: Store['trpc'] | undefined): string {
  const [url, setUrl] = useState(() => mobileHandoffUrl(window.location.origin))
  useEffect(() => {
    if (!trpc) return
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const info = await trpc.setup.info.query()
        // `appUrl` first: it is the host that actually SERVES the page, and the
        // public URL would only bounce the phone here anyway.
        const origin = info.appUrl || info.publicUrl
        if (cancelled || typeof origin !== 'string' || origin === '') return
        setUrl(mobileHandoffUrl(origin))
      } catch {
        // The window's own origin stays — right on any instance reached by the
        // address it is actually served from, which is the common case.
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [trpc])
  return url
}

/**
 * THE GATE, shared by both surfaces: one task has been created.
 *
 * Before that there is nothing on a phone to watch, so an invitation would be
 * an ad in a status bar. Deliberately "a task exists", not "a task is open" —
 * the pitch is about carrying work around, and a shell with work in it has
 * earned it whatever state that work is in.
 */
export function useHasFirstTask(): boolean {
  const issues = useReplicaIssues()
  return issues.some((issue) => !issue.deletedAt)
}

const parseDismissed = (raw: string | null): boolean => raw === 'true'
/** `null` deletes the row, so "not dismissed" leaves nothing behind. */
const serializeDismissed = (value: boolean): string | null => (value ? 'true' : null)

/**
 * Has the promo card been turned down? Replicated, so the answer follows the
 * person to the next browser rather than being re-asked on every device.
 */
export function useMobilePromoDismissed(): [boolean, (next: boolean) => void] {
  return usePersistedUiState(MOBILE_PROMO_DISMISSED_KEY, parseDismissed, serializeDismissed)
}
