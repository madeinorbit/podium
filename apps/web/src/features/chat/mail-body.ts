/**
 * A MESSAGE BODY THE TRANSCRIPT DOES NOT HOLD, BY ID (POD-2143).
 *
 * An oversized mail reaches the agent as a one-line inbox pointer, so its body
 * never enters the transcript. The chat fetches it through `messages.show` (the
 * ledger's own `mayView` gate) only when the reader opens the note, and keeps
 * it for the page's life: a delivered body does not change. Any mail card that
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
  /** The `mayView` gate keeps this reader out; retrying cannot help. */
  | { status: 'denied' }
  | { status: 'error'; retry: () => void }

const bodies = new Map<string, Promise<string>>()

function fetchMailBody(trpc: Trpc, id: string): Promise<string> {
  let body = bodies.get(id)
  if (!body) {
    body = trpc.messages.show.query({ id }).then((m) => (m as { body: string }).body)
    // A refusal or a dropped connection is not the answer; the next open asks again.
    body.catch(() => bodies.delete(id))
    bodies.set(id, body)
  }
  return body
}

/** The body of message `id`, fetched on first mount and cached. */
export function useMailBody(id: string): MailBody {
  const { trpc } = useStoreHandle<Trpc>().access
  const [state, setState] = useState<MailBody>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is the retry trigger.
  useEffect(() => {
    let live = true
    setState((s) => (s.status === 'loading' ? s : { status: 'loading' }))
    fetchMailBody(trpc, id).then(
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
  }, [trpc, id, attempt])
  return state
}
