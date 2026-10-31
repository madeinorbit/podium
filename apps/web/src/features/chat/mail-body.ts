/**
 * A MESSAGE BODY THE TRANSCRIPT DOES NOT HOLD, BY ID (POD-2143).
 *
 * An oversized mail reaches the agent as a one-line inbox pointer, so its body
 * never enters the transcript. The chat fetches it through `messages.show` (the
 * ledger's own read gate) only when the reader opens the note, and keeps the
 * last few: a delivered body does not change. The cache belongs to the store
 * handle, so signing out (a new handle) drops it with everything else the
 * account read. Any mail card that
 * shows a body it was not typed (an outgoing "Note to X", POD-2146) uses the
 * same hook.
 */

import { useStoreHandle } from '@podium/client-core/react'
import { MAIL_VIEW_REFUSED } from '@podium/commands/mail-pointer-nudge'
import { useEffect, useState } from 'react'
import type { Trpc } from '@/app/trpc'

export type MailBody =
  | { status: 'loading' }
  | { status: 'ready'; body: string }
  /** The read gate keeps this reader out; retrying cannot help. */
  | { status: 'denied' }
  | { status: 'error'; retry: () => void }

/** Bodies kept per store handle, most recently opened last. */
const BODIES_KEPT = 50
const cachesByHandle = new WeakMap<object, Map<string, Promise<string>>>()

export function fetchMailBody(handle: object, trpc: Trpc, id: string): Promise<string> {
  const bodies = cachesByHandle.get(handle) ?? new Map<string, Promise<string>>()
  cachesByHandle.set(handle, bodies)
  let body = bodies.get(id)
  if (body) {
    // Re-insert to mark it most recent; an in-flight read is shared the same way.
    bodies.delete(id)
    bodies.set(id, body)
  } else {
    body = trpc.messages.show.query({ id }).then((m) => (m as { body: string }).body)
    // A refusal or a dropped connection is not the answer; the next open asks again.
    const asked = body
    body.catch(() => bodies.get(id) === asked && bodies.delete(id))
    bodies.set(id, body)
    if (bodies.size > BODIES_KEPT) bodies.delete(bodies.keys().next().value as string)
  }
  return body
}

/** The body of message `id`, fetched on first mount and cached. */
export function useMailBody(id: string): MailBody {
  const handle = useStoreHandle<Trpc>()
  const { trpc } = handle.access
  const [state, setState] = useState<MailBody>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is the retry trigger.
  useEffect(() => {
    let live = true
    setState((s) => (s.status === 'loading' ? s : { status: 'loading' }))
    fetchMailBody(handle, trpc, id).then(
      (body) => live && setState({ status: 'ready', body }),
      (error: unknown) =>
        live &&
        setState(
          error instanceof Error && error.message === MAIL_VIEW_REFUSED
            ? { status: 'denied' }
            : { status: 'error', retry: () => setAttempt((n) => n + 1) },
        ),
    )
    return () => {
      live = false
    }
  }, [handle, trpc, id, attempt])
  return state
}
