/**
 * THE POSTURE A SESSION WAS STARTED ON, KEPT ON ITS MACHINE (POD-6858,
 * harness-session-posture.md §4.2).
 *
 * The server states a session's posture once, in the spawn frame. The daemon
 * resolves it (absent means `DEFAULT_SESSION_POSTURE`) and records it here, a
 * small file per session under the daemon's state folder. A launch with no
 * frame in hand — a headless reattach, a client terminal attached to an
 * engine — runs on the recorded terms, so a resume or wake while the server
 * is unreachable keeps the posture the session started with.
 *
 * The vendor engine families need none of this: they journal the session's
 * spec, posture included, and adopt from it.
 */

import type { SessionId } from '@podium/model'
import {
  DEFAULT_SESSION_POSTURE,
  type SessionPosture,
  SessionPostureSchema,
} from '@podium/protocol'
import { createEngineJournal } from './session/journal'

interface SessionPostureEntry {
  sessionId: SessionId
  posture: SessionPosture
}

/** Where the records live: one JSON file per session under the state folder. */
export const SESSION_POSTURE_NAMESPACE = 'session-posture'

let journal: ReturnType<typeof createEngineJournal<SessionPostureEntry>> | undefined
function store() {
  journal ??= createEngineJournal<SessionPostureEntry>({ namespace: SESSION_POSTURE_NAMESPACE })
  return journal
}

/** The posture a spawn frame states, resolved: absent is the default. */
export function spawnPosture(msg: { posture?: SessionPosture | undefined }): SessionPosture {
  return msg.posture ?? DEFAULT_SESSION_POSTURE
}

/** Record the posture a session runs on. A write that fails is logged by the
 *  journal and costs only a later frameless launch its recorded terms. */
export function recordSessionPosture(sessionId: SessionId, posture: SessionPosture): void {
  store().write({ sessionId, posture })
}

/** The posture a session was recorded with, or the default when there is no
 *  readable record (a session from before this record existed). */
export function storedSessionPosture(sessionId: SessionId): SessionPosture {
  const parsed = SessionPostureSchema.safeParse(store().read(sessionId)?.posture)
  return parsed.success ? parsed.data : DEFAULT_SESSION_POSTURE
}

/** Drop a retired session's record. */
export function forgetSessionPosture(sessionId: SessionId): void {
  store().clear(sessionId)
}
