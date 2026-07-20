/**
 * Delivered-message envelope detection (#237) [spec:SP-34d7 web]: a message
 * from another agent / the superagent / the system reaches the harness as a
 * server-rendered frame — `[podium message …] … [end podium message …]` — so
 * it lands in the transcript as a "user" turn. The web transcript must render
 * it DISTINCT from something the human typed; conversely an operator message
 * is delivered unwrapped and renders exactly as a user turn (unwrapped = the
 * human — this parser simply never matches it).
 *
 * Spoof-resistance mirrors the server invariant: only the server writes
 * frames, so a fake `[podium message …]` INSIDE a body sits inside the real
 * frame — we anchor on the FIRST head line and the LAST matching end line, so
 * quoted frames stay quoted inside the rendered body.
 */

export interface ParsedEnvelope {
  /** The message id (`msg_…`) — links the transcript block to the ledger. */
  id: string
  /** Sender label as the server rendered it (`issue:POD-13`, legacy
   *  `issue:#212`, `session:s1`, `superagent`, `system`, …). */
  from: string
  to: string
  /** The body between the frames, with trailing server boilerplate (rule
   *  lines, cross-machine note) stripped. */
  body: string
  /** True when the frame carried the `[this is a question: …]` binding rule. */
  question: boolean
  /** True when the frame carried the `[a response was requested: …]` rule
   *  (`--expect-response` [spec:SP-bf44]) — questions carry their own,
   *  stronger rule and leave this false. */
  expectsReply: boolean
  /** The cross-machine provenance note [spec:SP-6d57] ("this agent runs on
   *  machine …"), when the sender runs elsewhere — rendered as a footer, not
   *  body text. */
  machineNote?: string
}

const HEAD_RE = /^\[podium message (\S+) · from (.+?) · to (.+?) · reply: podium mail reply \1\]\n/

/** Parse a transcript user-turn's text as a delivered-message envelope.
 *  Returns null for anything that isn't exactly one server frame (operator
 *  text, ordinary prompts, partial matches). */
export function parseMessageEnvelope(text: string): ParsedEnvelope | null {
  const trimmed = text.trim()
  const head = HEAD_RE.exec(trimmed)
  if (!head) return null
  const [, id, from, to] = head
  if (!id || !from || !to) return null
  const endTag = `[end podium message ${id}]`
  if (!trimmed.endsWith(endTag)) return null
  let body = trimmed.slice(head[0].length, trimmed.length - endTag.length)
  // Server boilerplate sits on the lines just before the end frame, in render
  // order body → note → question/response rule. Strip back-to-front and mark
  // the block instead of rendering the raw instructions.
  const questionRe = /\n?\[this is a question: [^\n]*\]\n?$/
  const question = questionRe.test(body)
  if (question) body = body.replace(questionRe, '')
  const responseRe = /\n?\[a response was requested: [^\n]*\]\n?$/
  const expectsReply = !question && responseRe.test(body)
  if (expectsReply) body = body.replace(responseRe, '')
  const noteRe = /\n?\[(this agent runs on machine [^\n]*?)\]\n?$/
  const note = noteRe.exec(body)
  if (note) body = body.replace(noteRe, '')
  return {
    id,
    from,
    to,
    body: body.replace(/\n$/, ''),
    question,
    expectsReply,
    ...(note?.[1] ? { machineNote: note[1] } : {}),
  }
}

/** A principal label split for rendering: `pre` + `ref` + `post`, where `ref`
 *  is a nice-id issue ref (`POD-13`) the header can render as a clickable
 *  ref-link chip, or null when the label carries none (legacy `#seq`,
 *  sessions, bare kinds). */
export interface EnvelopePrincipal {
  pre: string
  ref: string | null
  post: string
}

/** Split a server-rendered principal label for the envelope header:
 *  `issue:POD-13` → "task " + chip(POD-13) + " · agent"; legacy `issue:#212`
 *  → plain "task #212 · agent"; `session:s1` → "session s1 · agent"; bare
 *  kinds pass through. Refs inside message bodies are linkified separately by
 *  the markdown ref pass (#474). */
export function envelopePrincipal(label: string): EnvelopePrincipal {
  // Only the two shapes the server actually renders (`#seq` legacy or a
  // nice-id ref); anything else passes through untouched rather than being
  // mislabelled.
  const issue = /^issue:(#\d+|[A-Z]{2,5}-\d+)$/.exec(label)
  if (issue?.[1]) {
    const ref = issue[1].startsWith('#') ? null : issue[1]
    return { pre: 'task ', ref, post: ref ? ' · agent' : `${issue[1]} · agent` }
  }
  const session = /^session:(\S+)$/.exec(label)
  if (session) return { pre: `session ${session[1]} · agent`, ref: null, post: '' }
  return { pre: label, ref: null, post: '' }
}

/** Human label for a server-rendered principal label (flat-text form of
 *  {@link envelopePrincipal}). */
export function envelopePrincipalLabel(label: string): string {
  const p = envelopePrincipal(label)
  return `${p.pre}${p.ref ?? ''}${p.post}`
}
