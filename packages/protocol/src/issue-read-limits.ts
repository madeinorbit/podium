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
 *   CONDITIONAL — total output stays inside `MAIL_INBOX_OUTPUT_BUDGET_BYTES` for
 *   a SUPPORTED page, which is the whole domain spelled out: at most
 *   `MAIL_INBOX_MAX_LIMIT` rows, each id within `MAIL_INBOX_MAX_ID_BYTES` (BYTES,
 *   not characters — see the domain note below, and note that `correlationId` can
 *   leave it), headers clipped to `MAIL_INBOX_MAX_HEADER_CHARS`, and a
 *   `showCommand` within `MAIL_INBOX_MAX_SHOW_COMMAND_BYTES` since the notice
 *   lines interpolate it. Outside that domain the ids still all render and the
 *   BUDGET is what gives, because consumption must never outrun the listing.
 *
 * So newest-first protects the newest for a MEASURED consumer budget, not for
 * every unknown cut size — no renderer can promise the latter.
 */
/**
 * THE SUPPORTED ID DOMAIN, in BYTES rather than characters [PDM-139].
 *
 * A 64-CHARACTER id is not a 64-byte id: one non-ASCII character can cost four
 * UTF-8 bytes, so a character count cannot establish a byte bound. Grounded in
 * the actual producers rather than assumed — both emit `msg_` + `randomUUID()`,
 * 40 ASCII bytes, comfortably inside this:
 *
 *   apps/server/src/modules/issues/service/mail.ts:65   `msg_${randomUUID()}`
 *   apps/server/src/modules/messages/service.ts:1108    `msg_${randomUUID()}`
 *
 * THE ONE PATH OUT OF THE DOMAIN, named rather than wished away: that second
 * site reads `input.correlationId ?? ...`, and `correlationId` is an unbounded
 * internal `string` (modules/messages/types.ts:65). It is not reachable from the
 * wire contract, but nothing in the type system keeps an id inside this bound.
 * The consequence is bounded and stated: an id beyond the domain can push a page
 * OVER BUDGET. It can never cost a row, because ids are never truncated and rows
 * are never dropped. No valid id is widened speculatively to accommodate this.
 */
export const MAIL_INBOX_MAX_ID_BYTES = 64
export const MAIL_INBOX_MAX_HEADER_CHARS = 120

/** The longest `showCommand` the notice allowance is sized for; both call sites
 *  pass `podium mail show` (16 bytes). */
export const MAIL_INBOX_MAX_SHOW_COMMAND_BYTES = 64

/**
 * Sized FROM the bound rather than picked round: the most degraded rendering of a
 * full page is one id per line, so the budget must hold
 * `MAIL_INBOX_MAX_LIMIT * (MAIL_INBOX_MAX_ID_BYTES + 1)` plus
 * `MAIL_INBOX_NOTICE_ALLOWANCE_BYTES`, which in turn covers the head lines at a
 * `showCommand` of up to `MAIL_INBOX_MAX_SHOW_COMMAND_BYTES`.
 * `mail-inbox-render.test.ts` asserts both relationships so the constants cannot
 * drift apart, which is the failure this file would otherwise invite.
 *
 * Both formulas are in BYTES throughout. An earlier revision wrote this one over
 * a CHARACTER constant, and renaming that constant did not redden anything —
 * prose naming a deleted identifier compiles perfectly well, which is exactly how
 * the two halves of this file came to disagree.
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

/**
 * THE ID GUARANTEE, applied to EVERY tier [PDM-139].
 *
 * The renderer takes `header` from its caller and cannot assume the caller put
 * the id in it. An earlier version enforced this only in the clipped-header tier,
 * so the two richest tiers — the ones a normal inbox actually uses — rendered
 * whatever the caller supplied. A SHORT header omitting its id produced a page
 * with no id for that row, which is the unrecoverable case, reached without any
 * oversized input and therefore invisible to a test that only probed clipping.
 */
const withId = (entry: InboxEntry, line: string): string =>
  line.includes(entry.id) ? line : `${entry.id} ${line}`

/** A header that can never lose its id, however long the caller made it. */
const clipHeader = (entry: InboxEntry): string =>
  withId(
    entry,
    entry.header.length <= MAIL_INBOX_MAX_HEADER_CHARS
      ? entry.header
      : `${entry.header.slice(0, MAIL_INBOX_MAX_HEADER_CHARS)}…`,
  )

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
    { blocks: newestFirst.map((e) => `${withId(e, e.header)}\n  ${e.body}`), header: head() },
    {
      blocks: newestFirst.map(
        (e) =>
          `${withId(e, e.header)}\n  ${clipBody(e.body, previewChars, e.id, opts.showCommand)}`,
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
