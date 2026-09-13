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
 * The defect here is a BYTE budget at the display layer: the server returned the
 * whole mailbox and something downstream cut the output, which is why the cut
 * point moved with message length rather than staying at a row count. Selecting
 * the newest N rows answers a different question. Measured on the mailbox that
 * produced the report — 1,133,164 bytes over 302 messages, a mean of 3,752 each
 * — a fifty-row page is ~187,600 bytes against an inline cut observed near
 * 214,000. Thirteen percent of margin. The row cap alone would have failed on
 * the very inbox that reported the bug.
 *
 * 16 KiB is chosen to sit far below any consumer cut we have seen rather than
 * just below the one we measured, because the budget belongs to the reader and
 * we do not get to know it.
 */
export const MAIL_INBOX_OUTPUT_BUDGET_BYTES = 16_384

/** Body characters kept per row once a page cannot be shown in full. */
export const MAIL_INBOX_PREVIEW_CHARS = 160

/** One mailbox row, as either CLI has already formatted its header line. */
export interface InboxEntry {
  /** The message id. MUST also appear in `header` — it is the read-by-id key. */
  id: string
  /** A single line: id, correspondents, timestamp, flags. */
  header: string
  body: string
}

export interface InboxRenderOptions {
  /** e.g. `podium mail show` — the actionable full-read route for one id. */
  showCommand: string
  /**
   * The page came back FULL, so older messages MAY exist.
   *
   * Deliberately a may-be, not a measurement. Measuring it means over-fetching
   * one row, and an inbox read MARKS WHAT IT RETURNS READ — so the probe row
   * would be consumed and never shown, which is the read-status defect this whole
   * issue is about. An honest "may" beats a precise fact bought that way.
   */
  pageWasFull: boolean
  budgetBytes?: number
  previewChars?: number
}

/**
 * UTF-8 byte length, through the SAME capability shim `binary-envelope.ts` uses.
 *
 * Not `Buffer`, and not a bare `TextEncoder`: this package is browser-safe and
 * its tsconfig is deliberately lean (`types: []`), so a node or DOM global
 * reaching this source reddens the L0 typecheck on purpose. Declaring the one
 * method needed and reading it off `globalThis` is how the package already
 * solves this next door.
 *
 * BYTES rather than characters, because the consumer cut that caused this defect
 * counts bytes — a character count would be quietly optimistic on multibyte mail,
 * which is precisely the long-body case this budget exists for.
 */
const utf8 = globalThis as unknown as { TextEncoder: new () => { encode(s: string): Uint8Array } }
const utf8Encoder = new utf8.TextEncoder()
const utf8Bytes = (text: string): number => utf8Encoder.encode(text).length

const clip = (body: string, chars: number, id: string, showCommand: string): string => {
  const flat = body.replace(/\s+/g, ' ').trim()
  if (flat.length <= chars) return flat
  const over = flat.length - chars
  return `${flat.slice(0, chars)}… (+${over} chars — ${showCommand} ${id})`
}

/**
 * Render a mailbox page so the NEWEST message survives a cut of unknown size.
 *
 * NEWEST FIRST, which is the whole mechanism rather than a preference. A
 * display-layer cut always takes the TAIL, so the only way to guarantee the
 * newest row survives is to put it at the HEAD. Ordering the page oldest-first
 * — however the rows were selected — hands the cut exactly the message the
 * reader came for. This reverses the order both inbox CLIs printed for years;
 * see the receipt for the compatibility decision.
 *
 * BOUNDED BY CONSTRUCTION, not by row count. Full bodies are printed while the
 * whole page fits the budget, because the bound must not cost the common case of
 * a short mailbox. The moment it does not fit, every row drops to a clipped
 * preview carrying its id and the command that reads it in full — so the page
 * shrinks without any row disappearing, and nothing is marked read that was
 * never shown.
 *
 * THE RECOVERY ROUTE IS READ-BY-ID, NOT WIDENING. Asking for more rows is the
 * wrong answer to a display cut: it increases the output that caused the loss.
 */
export function renderInboxPage(entries: InboxEntry[], opts: InboxRenderOptions): string {
  const budget = opts.budgetBytes ?? MAIL_INBOX_OUTPUT_BUDGET_BYTES
  const previewChars = opts.previewChars ?? MAIL_INBOX_PREVIEW_CHARS
  const newestFirst = [...entries].reverse()

  const full = newestFirst.map((e) => `${e.header}\n  ${e.body}`)
  const head = [
    `NEWEST FIRST — ${entries.length} message${entries.length === 1 ? '' : 's'}.`,
    opts.pageWasFull ? `  This page is full — there MAY be older messages not listed.` : null,
    `  Read one in full: ${opts.showCommand} <id>`,
  ].filter((l): l is string => l !== null)

  const asText = (blocks: string[], header: string[]) => [...header, '', ...blocks].join('\n')
  const fullText = asText(full, head)
  if (utf8Bytes(fullText) <= budget) return fullText

  // Over budget: every row keeps its header and id, bodies become previews.
  const previews = newestFirst.map(
    (e) => `${e.header}\n  ${clip(e.body, previewChars, e.id, opts.showCommand)}`,
  )
  const clippedHead = [...head, `  Bodies are shortened to fit; ids above are complete.`]
  const previewText = asText(previews, clippedHead)
  if (utf8Bytes(previewText) <= budget) return previewText

  // Still over: the page itself is too long to show even as previews. Drop from
  // the OLDEST end — the end a cut would have taken anyway — and say how many,
  // so the reader is told rather than left to infer it from a short list.
  const kept: string[] = []
  // RESERVE THE WITHHELD LINE BEFORE MEASURING ANYTHING ELSE. Its text depends on
  // a count this loop has not produced yet, so budget for the worst case (every
  // row dropped); a loop that measures the header it is NOT going to print
  // overshoots by exactly the line it forgot, which is how this first ran 38
  // bytes over its own guarantee.
  const withheldLine = (n: number) =>
    `  ${n} older row${n === 1 ? '' : 's'} withheld to stay inside the output budget.`
  let used = utf8Bytes(asText([], [...clippedHead, withheldLine(previews.length)]))
  for (const block of previews) {
    const cost = utf8Bytes(block) + 1
    if (used + cost > budget) break
    kept.push(block)
    used += cost
  }
  const dropped = previews.length - kept.length
  return asText(kept, [...clippedHead, withheldLine(dropped)])
}
