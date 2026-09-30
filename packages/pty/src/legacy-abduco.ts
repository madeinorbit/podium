import { createLogger } from '@podium/logger'

const log = createLogger('pty:durable')

/**
 * AN abduco SESSION THAT CANNOT BE ADOPTED HERE (POD-4986).
 *
 * Nothing creates abduco sessions any more, but running ones are adopted
 * (`abducoAdoptionAdapter`), and attaching needs the abduco client. On a
 * machine where none can be had, the session is not re-adopted: this says so
 * — once per label, so the operator can tell a session that is still running
 * somewhere from one that died — and the master and its program are left
 * alone. Nothing here runs abduco, connects to a master or signals anything.
 */
const noted = new Set<string>()

/** Log, once per label for this daemon's life, that `label`'s abduco session is left alone. */
export function noteUnadoptableAbducoSession(label: string, socketPath: string): void {
  if (noted.has(label)) return
  noted.add(label)
  log.warn(
    'session is held by an abduco master, and no abduco client is available here to attach it: not re-adopting it, and leaving its process running',
    { label, socketPath },
  )
}

/** Tests only: forget which labels were already logged. */
export function resetUnadoptableAbducoNotesForTests(): void {
  noted.clear()
}
