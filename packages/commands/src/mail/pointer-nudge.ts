/**
 * THE INBOX POINTER [POD-2143] — the one line the server types in place of an
 * oversized issue-addressed body ("you have mail, read your inbox"), and the
 * shape the client parses back out of the transcript. One copy here, beside the
 * turn-close rule, so the renderer and the parser cannot drift: a reworded
 * pointer the client no longer recognised rendered as a human "You" bubble.
 *
 * Each sender carries its message ids in parentheses, so the chat can fetch the
 * body by id when the reader opens the note. Pointers typed before the ids were
 * added still sit in transcripts, under three tails over time (bare "to read
 * them", POD-604's restate-your-summary rule, today's); they parse with an
 * empty id list.
 */

/** A sender and the ids of its messages this pointer stands for. */
export interface MailPointerSender {
  /** The server's principal label (`issue:POD-13`, `superagent`, …). */
  from: string
  /** Message ids, in arrival order; empty for a legacy pointer. */
  ids: string[]
}

const HEAD = '[podium] '

/** What `mail.show` refuses a reader its `mayView` gate keeps out with. Shared
 *  so the chat can tell "you may not see this" from a load that failed. */
export const MAIL_VIEW_REFUSED = 'not allowed to view a message you neither sent nor received'

/** The pointer path closes its turn by the same rule as the envelope's
 *  TURN_CLOSE_RULE [POD-604, POD-2070]. Said in one line here because a
 *  coalesced nudge has to stay a nudge. */
const STEM = ` — run 'podium issue mail inbox' to read them`
const TAIL =
  `${STEM}, then close your turn without repeating your ` +
  `last answer: no message if they needed nothing or only a reply, one sentence if you acted ` +
  `on them, more only if they change what you told the human; leave your standing offer as it is`

/** The pointer line for `count` messages from `senders`. */
export function renderMailPointer(count: number, senders: readonly MailPointerSender[]): string {
  const from = senders
    .map((s) => (s.ids.length > 0 ? `${s.from} (${s.ids.join(', ')})` : s.from))
    .join(', ')
  return `${HEAD}${count} message(s) from ${from}${TAIL}`
}

const HEAD_RE = /^\[podium\] (\d+) message\(s\) from /
const SENDER_WITH_IDS_RE = /^(\S+) \((msg_[^\s,()]+(?:, msg_[^\s,()]+)*)\)(?:, |$)/

/** Parse a pointer at the START of `text`. Returns its senders and the text
 *  after it, or null when `text` does not open with a pointer. A pointer with
 *  ids must end on the exact current tail. A legacy one (no ids) ends on any of
 *  its historical tails, so it is matched by the stem they share and the rest
 *  of its line. */
export function parseMailPointer(
  text: string,
): { count: number; senders: MailPointerSender[]; rest: string } | null {
  const head = HEAD_RE.exec(text)
  if (!head) return null
  const stemAt = text.indexOf(STEM, head[0].length)
  if (stemAt < 0) return null
  const from = text.slice(head[0].length, stemAt)
  if (from === '' || from.includes('\n')) return null
  const senders: MailPointerSender[] = []
  let end: number
  if (SENDER_WITH_IDS_RE.test(from)) {
    if (!text.startsWith(TAIL, stemAt)) return null
    end = stemAt + TAIL.length
    let rest = from
    while (rest !== '') {
      const m = SENDER_WITH_IDS_RE.exec(rest)
      if (!m?.[1] || !m[2]) return null
      senders.push({ from: m[1], ids: m[2].split(', ') })
      rest = rest.slice(m[0].length)
    }
  } else {
    for (const label of from.split(', ')) senders.push({ from: label, ids: [] })
    const newline = text.indexOf('\n', stemAt)
    end = newline < 0 ? text.length : newline
  }
  return { count: Number(head[1]), senders, rest: text.slice(end) }
}
