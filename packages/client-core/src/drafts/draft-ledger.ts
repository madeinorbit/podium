/**
 * THE DRAFT LEDGER (POD-2045) — what this device believes about each session's
 * composer, and who wins when the server disagrees.
 *
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS: A DRAFT IS THE ONE THING A SERVER MAY NEVER TAKE BACK
 * ---------------------------------------------------------------------------
 *
 * Typing is the most local act in the product. It happens at the speed of a
 * person's hands, on a device they are holding, and it is unrecoverable — a
 * transcript can be re-fetched, a draft cannot. So the composer is offline-first
 * in the strong sense: the local text is the truth, the server's copy is a
 * mirror kept for the OTHER devices, and no message arriving over a socket may
 * ever roll back a sentence someone is in the middle of.
 *
 * That was not true before this module. Every keystroke went out as a
 * fire-and-forget frame that was silently DROPPED while disconnected, and every
 * arriving `sessionDraftChanged` was adopted unconditionally. A slow server
 * therefore produced exactly the wrong pairing: the frames carrying the newest
 * text were the ones thrown away, and the reconnect replay that followed carried
 * text older than what was on screen — which was then written over it. Text
 * vanished mid-sentence, and it vanished WORSE the slower the server got.
 *
 * ---------------------------------------------------------------------------
 * THE RULE, IN ONE LINE
 * ---------------------------------------------------------------------------
 *
 *   A DIRTY LOCAL DRAFT ALWAYS WINS LOCALLY, AND ALWAYS RE-OFFERS ITSELF.
 *
 * `dirty` means "this text has not been confirmed by the server yet" — the
 * person typed it and the echo has not come back. While that holds, an incoming
 * document may update our idea of the server's REV, but never our TEXT. And
 * because our text is now known to differ from the server's, it is re-sent: the
 * two converge on ours, which is the one the human can see.
 *
 * The rev is adopted even when the text is refused, and that is the subtle half.
 * A resend carries `baseRev`, and the server's arbitration rejects an edit whose
 * base is stale (outside the soft lease). Refusing the rev while refusing the
 * text would guarantee that every resend was rejected — the client would shout
 * the same losing sentence forever. Taking the rev and keeping the text is what
 * makes "ours wins" terminate.
 *
 * It terminates in BOTH directions, which is the part POD-1204 had to repair: the
 * rev the sequencer names is taken even when it is LOWER than the one we hold.
 * See {@link DraftLedger.adoptRemote}.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS NOT
 * ---------------------------------------------------------------------------
 *
 * It is NOT a second sequencer. It assigns no revs, merges no text, and holds no
 * history — {@link applyDraftEdit} in `@podium/model` is the arbitration, it runs
 * on the server, and it stays there. This is the smaller, client-side question
 * that the server cannot answer because it cannot see the caret: *is what I am
 * being told newer than what this person is typing?*
 *
 * It is also NOT the op-stream conflict class the composer's doc comment
 * reserves for a future phase. A character-level merge of two people typing into
 * one composer is a different feature; this makes the single-typist case correct
 * offline, which is the case that was broken.
 *
 * PURE: no timers, no sockets, no storage, no clock. The caller supplies `atMs`
 * and owns every side effect, so the whole policy is testable as data in, data
 * out — and the runtime that wires it up holds no arbitration of its own.
 */
import type { SessionId } from '@podium/model/browser'

export interface LocalDraft {
  /** The composer text this device believes in. */
  text: string
  /** Highest server rev seen for this session (0 = the server never spoke).
   *  Sent as `baseRev` on the next edit. */
  serverRev: number
  /** True while a local edit has not been confirmed echoed by the server. */
  dirty: boolean
  /** Local wall-clock ms of the last local edit. Diagnostics and persistence
   *  ordering only — never arbitration, which is the server's rev. */
  editedAt: number
}

export interface AdoptOutcome {
  /** Overwrite the visible store text with the incoming text? */
  acceptText: boolean
  /** (Re)send the local text — the server holds something else and we win? */
  resend: boolean
}

/** The persisted form: a plain JSON object, one entry per session with text. */
export type DraftLedgerSnapshot = Record<
  string,
  { text: string; serverRev: number; editedAt: number }
>

export interface DraftLedger {
  /** Record a local keystroke. Marks the entry dirty and stamps `atMs`. */
  localEdit(sessionId: SessionId, text: string, atMs: number): void
  /**
   * Arbitrate an arriving `sessionDraftChanged`. A legacy server sends no `rev`,
   * which is treated as "no rev information" rather than as rev 0.
   *
   * A rev that is present is ALWAYS adopted, in either direction — the server is
   * the only authority on where in the sequence it currently is, and it can move
   * back (POD-1204).
   */
  adoptRemote(sessionId: SessionId, incoming: { text: string; rev?: number }): AdoptOutcome
  get(sessionId: SessionId): LocalDraft | undefined
  /** Sessions holding unsent text — the reconnect flush set. */
  dirtySessions(): SessionId[]
  /** Persistable snapshot. Empty drafts are omitted: there is nothing to lose. */
  snapshot(): DraftLedgerSnapshot
  /**
   * Rehydrate from {@link snapshot}. Restored text is marked DIRTY: a draft
   * written while the socket was down may never have reached the server, and
   * re-offering it costs one no-op edit the server dedups, where staying quiet
   * would lose it on every other device permanently.
   */
  restore(data: DraftLedgerSnapshot): void
  remove(sessionId: SessionId): void
}

function isRestorable(v: unknown): v is { text: string; serverRev: number; editedAt: number } {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return typeof r.text === 'string' && typeof r.serverRev === 'number'
}

export function createDraftLedger(): DraftLedger {
  const entries = new Map<SessionId, LocalDraft>()

  return {
    localEdit(sessionId, text, atMs) {
      const previous = entries.get(sessionId)
      entries.set(sessionId, {
        text,
        serverRev: previous?.serverRev ?? 0,
        dirty: true,
        editedAt: atMs,
      })
    },

    adoptRemote(sessionId, incoming) {
      const local = entries.get(sessionId)
      // THE SEQUENCER'S POSITION IS WHATEVER IT SAYS IT IS — INCLUDING BACKWARDS
      // (POD-1204).
      //
      // This used to keep only the HIGHEST rev it had ever seen, on the reasoning
      // that an older rev is an out-of-order frame with nothing to teach us. But
      // frames for one session arrive over one ordered socket, so a lower rev is
      // not a reordering artefact — it is the server telling us it MOVED BACK,
      // which really happens: its document is persisted on a debounce, so a
      // restart (or any re-hydration from the store) can reload a rev below the
      // one it already broadcast.
      //
      // Refusing that answer was a permanent wedge. Every later edit went out
      // with a `baseRev` above the document's, the soft lease had long lapsed, so
      // the server rejected it and replied with its own lower rev — which we then
      // discarded, and resent the same losing base forever. The composer's
      // clear-on-submit is one of those edits, and a draft that cannot be cleared
      // holds the operator's own chat sends indefinitely (see the delivery guard
      // in the server's message service).
      //
      // Taking the rev costs at most one extra rejected round trip if a frame
      // ever did arrive out of order — the next answer corrects it. Not taking it
      // costs the session.
      const nextRev = incoming.rev ?? local?.serverRev ?? 0

      // Nothing local, or nothing unsent: the server is simply the better
      // informed party and we take what it says.
      if (!local || !local.dirty) {
        const acceptText = local?.text !== incoming.text
        entries.set(sessionId, {
          text: incoming.text,
          serverRev: nextRev,
          dirty: false,
          editedAt: local?.editedAt ?? 0,
        })
        return { acceptText, resend: false }
      }

      // Our own edit came back. The document now says what we say, so the entry
      // is settled — nothing to repaint, nothing left to send.
      if (local.text === incoming.text) {
        entries.set(sessionId, { ...local, serverRev: nextRev, dirty: false })
        return { acceptText: false, resend: false }
      }

      // The disagreement case, and the whole point of this module: keep the
      // person's text, take the server's place in the sequence, say it again.
      entries.set(sessionId, { ...local, serverRev: nextRev })
      return { acceptText: false, resend: true }
    },

    get: (sessionId) => entries.get(sessionId),

    dirtySessions: () =>
      [...entries.entries()].filter(([, draft]) => draft.dirty).map(([sessionId]) => sessionId),

    snapshot() {
      const out: DraftLedgerSnapshot = {}
      for (const [sessionId, draft] of entries) {
        if (!draft.text) continue
        out[sessionId] = {
          text: draft.text,
          serverRev: draft.serverRev,
          editedAt: draft.editedAt,
        }
      }
      return out
    },

    restore(data) {
      for (const [sessionId, stored] of Object.entries(data)) {
        // A persisted blob is device state that survived a reload, a version
        // change and possibly a crash mid-write. One unreadable entry must cost
        // that one draft, never the others.
        if (!isRestorable(stored) || !stored.text) continue
        entries.set(sessionId as SessionId, {
          text: stored.text,
          serverRev: stored.serverRev,
          dirty: true,
          editedAt: typeof stored.editedAt === 'number' ? stored.editedAt : 0,
        })
      }
    },

    remove(sessionId) {
      entries.delete(sessionId)
    },
  }
}
