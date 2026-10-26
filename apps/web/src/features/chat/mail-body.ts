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
import { useEffect, useState } from 'react'
import type { Trpc } from '@/app/trpc'

export type MailBody =
  | { status: 'loading' }
  | { status: 'ready'; body: string }
  | { status: 'error' }

const bodies = new Map<string, Promise<string>>()

function fetchMailBody(trpc: Trpc, id: string): Promise<string> {
  let body = bodies.get(id)
  if (!body) {
    body = trpc.messages.show.query({ id }).then((m) => (m as { body: string }).body)
    // A refusal or a dropped connection is not the answer; the next open retries.
    body.catch(() => bodies.delete(id))
    bodies.set(id, body)
  }
  return body
}

/** The body of message `id`, fetched on first mount and cached. */
export function useMailBody(id: string): MailBody {
  const { trpc } = useStoreHandle<Trpc>().access
  const [state, setState] = useState<MailBody>({ status: 'loading' })
  useEffect(() => {
    let live = true
    fetchMailBody(trpc, id).then(
      (body) => live && setState({ status: 'ready', body }),
      () => live && setState({ status: 'error' }),
    )
    return () => {
      live = false
    }
  }, [trpc, id])
  return state
}
