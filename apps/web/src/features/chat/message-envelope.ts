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
  /** Sender label as the server rendered it (`issue:#212`, `session:s1`,
   *  `superagent`, `system`, …). */
  from: string
  to: string
  /** The body between the frames, with a trailing question-rule line (server
   *  boilerplate) stripped. */
  body: string
  /** True when the frame carried the `[this is a question: …]` binding rule. */
  question: boolean
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
  // The question rule is server boilerplate on the line before the end frame —
  // strip it and mark the block instead of rendering the raw instruction.
  const questionRe = /\n?\[this is a question: [^\n]*\]\n?$/
  const question = questionRe.test(body)
  if (question) body = body.replace(questionRe, '')
  return { id, from, to, body: body.replace(/\n$/, ''), question }
}

/** Human label for a server-rendered principal label: `issue:#212` or the
 *  nice-id form `issue:POD-13` → "issue POD-13 · agent", `session:s1` →
 *  "session s1 · agent", the bare kinds pass through. Nice-id refs inside message
 *  bodies are linkified separately by the markdown ref pass (#474). */
export function envelopePrincipalLabel(label: string): string {
  // Only the two shapes the server actually renders (`#seq` or a nice-id ref);
  // anything else passes through untouched rather than being mislabelled.
  const issue = /^issue:(#\d+|[A-Z]{2,5}-\d+)$/.exec(label)
  if (issue) return `task ${issue[1]} · agent`
  const session = /^session:(\S+)$/.exec(label)
  if (session) return `session ${session[1]} · agent`
  return label
}
