import type { StoreNotices } from '@podium/client-core/react'
import { type ReactNode, useCallback, useMemo, useState } from 'react'
import { ShellErrorBanner } from '../components/ShellErrorBanner'
import { type MobileShell, MobileShellProvider } from './shell'

/**
 * THE PHONE'S ERROR CHANNEL (POD-4662).
 *
 * One piece of state, two doors in: the `StoreNotices` the engine is handed
 * (its `error` — a message not sent to a deleted session, a refused change),
 * and `report` for the composition root's own failures (a fatal store error, a
 * credential check). Out: the shell's `error`, with its dismissal.
 *
 * `info` stays a no-op: the engine's only info is a transient "a session moved
 * to X" toast, and this is a STICKY banner. Routing the toast into it would
 * leave a stale line on screen.
 */
export function useShellErrorChannel(): {
  readonly error: MobileShell['error']
  report(message: string): void
  readonly notices: StoreNotices
} {
  const [message, setMessage] = useState<string | null>(null)
  const report = useCallback((next: string) => setMessage(next), [])
  const notices = useMemo<StoreNotices>(() => ({ error: report, info: () => {} }), [report])
  const error = useMemo(
    () => (message === null ? null : { message, dismiss: () => setMessage(null) }),
    [message],
  )
  return { error, report, notices }
}

/**
 * The shell context, plus the surfaces the shell itself draws over every
 * route. Mounted once by the composition root; a screen never renders the
 * shell's error itself.
 */
export function MobileShellSurface({
  value,
  children,
}: {
  value: MobileShell
  children: ReactNode
}) {
  return (
    <MobileShellProvider value={value}>
      {children}
      <ShellErrorBanner />
    </MobileShellProvider>
  )
}
