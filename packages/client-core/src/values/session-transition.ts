/**
 * WHAT A SESSION IS ON ITS WAY TO, AND WHETHER THE SERVER REFUSED IT
 * (ADR 12 D5 E1, POD-6399).
 *
 * A session's record carries what it should be (`desired`) beside what the
 * daemon observes (`status`). `revision` is its spec revision: every edit moves
 * it by one, and the device paints an edit it has not had confirmed as the
 * revision that edit will make. `observedRevision` is the server controller's
 * acknowledgement. So the session is still on its way while `revision` is ahead
 * of `observedRevision`, on this device before the receipt and on every device
 * after it, with no per-command display code.
 *
 * A refusal (`lifecycleFailure`) belongs to one revision: it shows while that
 * is still the current one, and the next edit clears it.
 */

import type { SessionMeta } from '@podium/model'

export type SessionTransition =
  | { readonly kind: 'starting' | 'stopping' | 'hibernating' }
  | {
      readonly kind: 'refused'
      readonly desired: NonNullable<SessionMeta['desired']>
      readonly reason: string
    }

type TransitionFields = Pick<
  SessionMeta,
  'desired' | 'revision' | 'observedRevision' | 'lifecycleFailure'
>

const ON_ITS_WAY = {
  running: 'starting',
  stopped: 'stopping',
  hibernated: 'hibernating',
} as const

/** Undefined when nothing is in flight and nothing was refused. */
export function sessionTransition(session: TransitionFields): SessionTransition | undefined {
  if (session.desired === undefined) return undefined
  const revision = session.revision ?? 1
  const observed = session.observedRevision ?? 1
  if (revision > observed) return { kind: ON_ITS_WAY[session.desired] }
  const failure = session.lifecycleFailure
  if (failure !== undefined && failure.revision === revision) {
    return { kind: 'refused', desired: session.desired, reason: failure.reason }
  }
  return undefined
}

/** The words for a transition, the same on every surface. */
export function sessionTransitionLabel(t: SessionTransition): string {
  switch (t.kind) {
    case 'starting':
      return 'Starting…'
    case 'stopping':
      return 'Stopping…'
    case 'hibernating':
      return 'Hibernating…'
    case 'refused':
      return t.desired === 'running'
        ? `Couldn't resume — ${t.reason}`
        : t.desired === 'stopped'
          ? `Couldn't end — ${t.reason}`
          : `Couldn't hibernate — ${t.reason}`
  }
}
