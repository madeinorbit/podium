/**
 * Output caps the bounded issue READ commands apply server-side.
 *
 * Declared here because two sides must agree on them: the server enforces them,
 * and the CLI names the cap (and the flag that raises it) in its truncation
 * footer. A cap the notice quotes wrongly is worse than no notice, so neither
 * side hardcodes its own copy.
 *
 * CARRIED FORWARD from main's `packages/protocol/src/commands.ts` (635cd759).
 * That file was retired by the rewrite because `packages/commands` replaced its
 * command-definition machinery (CommandDef/defineCommands/ISSUE_COMMAND_NAMES).
 * These three constants are unrelated to that machinery — they are shared
 * configuration — so they were ported here rather than deleted with it.
 * Deleting them would have silently dropped main's truncation footer, whose
 * whole point is that the number it prints is the number the server used.
 */
export const ISSUE_TREE_DEFAULT_MAX_DEPTH = 3
export const ISSUE_TREE_DEFAULT_MAX_NODES = 100
export const ISSUE_EVENTS_DEFAULT_LIMIT = 200

/**
 * The page `podium mail inbox` and `podium issue mail inbox` ask for, and the
 * ceiling `--limit` may raise it to [PDM-407].
 *
 * A MAILBOX CAP HAS A DIRECTION, and picking the wrong one is what made a busy
 * mailbox unreadable: capped with the ascending scan the delivery path wants,
 * both listings returned the OLDEST page, so the unread count climbed while
 * every row the reader could see was one it had already read. The newest page is
 * the one a reader is asking for.
 */
export const MAIL_INBOX_DEFAULT_LIMIT = 50
export const MAIL_INBOX_MAX_LIMIT = 500

/**
 * THE OUTPUT BUDGET, and why a mailbox page needs one at all [PDM-407].
 *
 * The defect is a BYTE budget at the display layer: the server returned the whole
 * mailbox and something downstream cut the output, which is why the cut point
 * moved with message length rather than staying at a row count. Measured on the
 * mailbox that produced the report — 1,133,164 bytes over 302 messages, mean
 * 3,752 each — a fifty-row page is ~187,600 bytes against an inline cut observed
 * near 214,000. Thirteen percent of margin.
 *
 * THE TWO GUARANTEES ARE NOT THE SAME STRENGTH, and saying so is the point
 * [PDM-139]:
 *
 *   UNCONDITIONAL — every row handed to the renderer has its ID rendered, newest
 *   first. Never a dropped row, at any budget, for any page. This is not a nicety:
 *   the server marks the page it RETURNS read, so a row the renderer omits has
 *   been consumed with no id shown and cannot be recovered. A notice counting how
 *   many were withheld does not give back their ids or their unread status.
 *
 *   CONDITIONAL — total output stays inside the budget for a SUPPORTED page:
 *   at most `MAIL_INBOX_MAX_LIMIT` rows with ids no longer than
 *   `MAIL_INBOX_MAX_ID_CHARS`. Beyond that the ids still all render and the budget
 *   is what gives, because consumption must never outrun the listing.
 *
 * So newest-first protects the newest for a MEASURED consumer budget, not for
 * every unknown cut size — no renderer can promise the latter.
 */
export const MAIL_INBOX_MAX_ID_CHARS = 64
export const MAIL_INBOX_MAX_HEADER_CHARS = 120

/**
 * Sized FROM the bound rather than picked round: the most degraded rendering of a
 * full page is one id per line, so the budget must hold
 * `MAIL_INBOX_MAX_LIMIT * (MAIL_INBOX_MAX_ID_CHARS + 1)` plus the notice lines.
 * `mail-inbox-render.test.ts` asserts that relationship so the constants cannot
 * drift apart, which is the failure this file would otherwise invite.
 */
export const MAIL_INBOX_NOTICE_ALLOWANCE_BYTES = 512
export const MAIL_INBOX_OUTPUT_BUDGET_BYTES = 40_960

/** Body characters kept per row once a page cannot be shown in full. */
export const MAIL_INBOX_PREVIEW_CHARS = 160

/** One mailbox row, as either CLI has already formatted its header line. */
export interface InboxEntry {
  /** The message id — the read-by-id key, and the thing that may never be lost. */
  id: string
  /** A single line: id, correspondents, timestamp, flags. */
  header: string
  body: string
}

export interface InboxRenderOptions {
  /** e.g. `podium mail show` — the actionable full-read route for one id. */
  showCommand: string
  /** The page came back FULL, so older messages MAY exist. Never asserted as fact. */
  pageWasFull: boolean
  budgetBytes?: number
  previewChars?: number
}

const utf8 = globalThis as unknown as { TextEncoder: new () => { encode(s: string): Uint8Array } }
const utf8Encoder = new utf8.TextEncoder()
const utf8Bytes = (text: string): number => utf8Encoder.encode(text).length

const clipBody = (body: string, chars: number, id: string, showCommand: string): string => {
  const flat = body.replace(/\s+/g, ' ').trim()
  if (flat.length <= chars) return flat
  return `${flat.slice(0, chars)}… (+${flat.length - chars} chars — ${showCommand} ${id})`
}

/** A header that can never lose its id, however long the caller made it. */
const clipHeader = (entry: InboxEntry): string => {
  const h =
    entry.header.length <= MAIL_INBOX_MAX_HEADER_CHARS
      ? entry.header
      : `${entry.header.slice(0, MAIL_INBOX_MAX_HEADER_CHARS)}…`
  return h.includes(entry.id) ? h : `${entry.id} ${h}`
}

/**
 * Render a mailbox page so the NEWEST message survives a cut of unknown size.
 *
 * NEWEST FIRST, which is the mechanism rather than a preference: a display cut
 * always takes the TAIL, so the only way the newest row survives is to put it at
 * the HEAD. Selecting the newest rows and then printing them oldest-first hands
 * the cut exactly the message the reader came for.
 *
 * FOUR TIERS, each rendering EVERY row. The richest that fits the budget wins, so
 * the page degrades in CONTENT and never in MEMBERSHIP:
 *
 *   1. header + full body   — the common case; the bound must not cost a short box
 *   2. header + preview     — body clipped, id and read-route retained
 *   3. clipped header       — identity, correspondents, flags
 *   4. id alone             — the floor, and it is never breached
 *
 * THE RECOVERY ROUTE IS READ-BY-ID, NOT WIDENING. Asking for more rows is the
 * wrong answer to output that was already too long.
 */
export function renderInboxPage(entries: InboxEntry[], opts: InboxRenderOptions): string {
  const budget = opts.budgetBytes ?? MAIL_INBOX_OUTPUT_BUDGET_BYTES
  const previewChars = opts.previewChars ?? MAIL_INBOX_PREVIEW_CHARS
  const newestFirst = [...entries].reverse()

  const head = (extra?: string) =>
    [
      `NEWEST FIRST — ${entries.length} message${entries.length === 1 ? '' : 's'}.`,
      opts.pageWasFull ? `  This page is full — there MAY be older messages not listed.` : null,
      `  Read one in full: ${opts.showCommand} <id>`,
      extra ?? null,
    ].filter((l): l is string => l !== null)

  const asText = (blocks: string[], header: string[]) => [...header, '', ...blocks].join('\n')

  const tiers: { blocks: string[]; header: string[] }[] = [
    { blocks: newestFirst.map((e) => `${e.header}\n  ${e.body}`), header: head() },
    {
      blocks: newestFirst.map(
        (e) => `${e.header}\n  ${clipBody(e.body, previewChars, e.id, opts.showCommand)}`,
      ),
      header: head('  Bodies are shortened to fit; every id above is complete.'),
    },
    {
      blocks: newestFirst.map(clipHeader),
      header: head('  Headers only — read any message with the command above.'),
    },
    {
      blocks: newestFirst.map((e) => e.id),
      header: head('  Ids only — this page could not be shown any other way.'),
    },
  ]

  for (const tier of tiers) {
    const text = asText(tier.blocks, tier.header)
    if (utf8Bytes(text) <= budget) return text
  }

  // Nothing fits: the page is beyond the supported bound, or the budget is
  // smaller than the notices. EVERY ID STILL RENDERS. The budget is the thing
  // that gives, never the listing — a row consumed but unnamed is unrecoverable,
  // and an over-budget page is merely long.
  const floor = tiers[tiers.length - 1]
  if (!floor) return ''
  return asText(floor.blocks, floor.header)
}
