/**
 * THE BOUNDED-OUTPUT ACCEPTANCE WITNESS [PDM-407, required by PDM-139].
 *
 * The defect this issue exists for is a BYTE budget at the display layer, not a
 * row cap — the server always returned the mailbox whole and something
 * downstream cut the output, which is why the cut point moved with message
 * length. The first fix answered it in ROWS: select the newest fifty. That
 * proves SQL selection and proves nothing about the defect, because fifty long
 * messages rendered oldest-first with full bodies exceed the same budget and
 * lose the newest row again.
 *
 * IT IS NOT A THEORETICAL MARGIN. Measured on the mailbox this issue was filed
 * from: 1,133,164 bytes over 302 messages, a mean of 3,752 bytes each. A
 * fifty-row page of that mail is ~187,600 bytes against an inline cut observed
 * at roughly 214,000 — inside 13%. The row fix would have failed on the very
 * inbox that produced the bug report.
 *
 * So the property under test is not a count. It is: WITH AN ARBITRARY CONSUMER
 * BUDGET, THE NEWEST MESSAGE'S ID AND AN ACTIONABLE FULL-READ ROUTE MUST BOTH
 * SURVIVE THE CUT.
 */
import { describe, expect, it } from 'vitest'
import {
  MAIL_INBOX_DEFAULT_LIMIT,
  MAIL_INBOX_MAX_HEADER_CHARS,
  MAIL_INBOX_MAX_ID_BYTES,
  MAIL_INBOX_MAX_LIMIT,
  MAIL_INBOX_MAX_SHOW_COMMAND_BYTES,
  MAIL_INBOX_NOTICE_ALLOWANCE_BYTES,
  MAIL_INBOX_OUTPUT_BUDGET_BYTES,
  renderInboxPage,
} from './issue-read-limits'

/** A body of the shape that actually breaks this: long, multiline, realistic. */
const longBody = (tag: string, lines = 40): string =>
  Array.from({ length: lines }, (_, i) => `${tag} paragraph ${i} ${'x'.repeat(80)}`).join('\n')

/** `n` entries OLDEST FIRST, the order every store here returns. */
const page = (n: number, lines = 40) =>
  Array.from({ length: n }, (_, i) => ({
    id: `msg_${String(i).padStart(3, '0')}`,
    header: `msg_${String(i).padStart(3, '0')} issue:#212 -> issue:#228 t${i} [queued]`,
    body: longBody(`m${i}`, lines),
  }))

/** The same lean-tsconfig shim the source uses; `types: []` means no DOM globals. */
const codecs = globalThis as unknown as {
  TextEncoder: new () => { encode(s: string): Uint8Array }
  TextDecoder: new () => { decode(b?: ArrayBufferView): string }
}
const utf8Len = (text: string): number => new codecs.TextEncoder().encode(text).length
/** What a consumer with a budget of `bytes` would actually see. */
const asSeenThrough = (text: string, bytes: number) =>
  new codecs.TextDecoder().decode(new codecs.TextEncoder().encode(text).subarray(0, bytes))

describe('renderInboxPage — the newest survives an arbitrary consumer cut', () => {
  it('puts the NEWEST id and its full-read route inside a budget far smaller than the page', () => {
    const entries = page(MAIL_INBOX_DEFAULT_LIMIT)
    const newest = entries[entries.length - 1]!.id
    const oldest = entries[0]!.id
    const out = renderInboxPage(entries, {
      showCommand: 'podium mail show',
      pageWasFull: true,
    })

    // A deliberately brutal consumer: 2KB, against a page of fifty long
    // messages. This is the cut the epic's real mailbox was suffering.
    const seen = asSeenThrough(out, 2048)
    expect(seen).toContain(newest)
    // AND the route, because an id with no way to read the message is the
    // "count that names nothing readable" defect in a new costume.
    expect(seen).toContain(`podium mail show ${newest}`)
    // BOTH DIRECTIONS: the oldest is what a cut is allowed to take. Without
    // this, a renderer that simply printed everything twice would pass.
    expect(seen).not.toContain(oldest)
  })

  it('NEVER DROPS A ROW — consumption must not outrun the listing [PDM-139]', () => {
    // THE INVARIANT THIS RENDERER EXISTS TO KEEP. The server marks the page it
    // RETURNS read. So a renderer that omits a row has consumed a message and
    // shown the reader no id for it — unrecoverable, and exactly the read-status
    // defect that made an over-fetch probe unacceptable. A count of how many
    // were withheld does not restore their ids or their unread status.
    //
    // Asserted at the worst page that can exist: the maximum page, maximum
    // headers, maximum bodies. An earlier version of this renderer dropped from
    // the oldest end here and reported the number, which is the bug.
    const entries = Array.from({ length: MAIL_INBOX_MAX_LIMIT }, (_, i) => ({
      id: `msg_${String(i).padStart(4, '0')}`,
      header: `msg_${String(i).padStart(4, '0')} ${'H'.repeat(MAIL_INBOX_MAX_HEADER_CHARS)}`,
      body: longBody(`m${i}`, 400),
    }))
    const out = renderInboxPage(entries, { showCommand: 'podium mail show', pageWasFull: true })
    for (const e of entries) expect(out).toContain(e.id)
    expect(utf8Len(out)).toBeLessThanOrEqual(MAIL_INBOX_OUTPUT_BUDGET_BYTES)
  })

  it('keeps every id even when the budget cannot hold the headers [PDM-139]', () => {
    // THE DEGENERATE BOUNDARY the reviewer named: a budget smaller than the
    // notices, or a single header larger than the whole budget. The bound is
    // CONDITIONAL on the supported page; NEVER-DROP is not. When the two cannot
    // both hold, the ids win and the budget is the thing that gives.
    const entries = page(20)
    const out = renderInboxPage(entries, {
      showCommand: 'podium mail show',
      pageWasFull: true,
      budgetBytes: 10,
    })
    for (const e of entries) expect(out).toContain(e.id)
  })

  it('renders ids newest-first even in the most degraded tier [PDM-139]', () => {
    // Degrading must not silently reverse the order the whole fix depends on.
    const entries = page(30)
    const out = renderInboxPage(entries, {
      showCommand: 'podium mail show',
      pageWasFull: true,
      budgetBytes: 400,
    })
    expect(out.indexOf('msg_029')).toBeLessThan(out.indexOf('msg_000'))
  })

  it('prints short mail in full — the bound must not cost the common case', () => {
    // The admission that pairs with the two bounds above: a renderer that always
    // previewed would satisfy them and would make every ordinary inbox worse.
    const entries = [
      { id: 'msg_a', header: 'msg_a from t0', body: 'short one' },
      { id: 'msg_b', header: 'msg_b from t1', body: 'short two' },
    ]
    const out = renderInboxPage(entries, { showCommand: 'podium mail show', pageWasFull: false })
    expect(out).toContain('short one')
    expect(out).toContain('short two')
    expect(out).not.toMatch(/TRUNCATED/)
  })

  it('never mentions older mail on a page that was not full', () => {
    // The old notice inferred "there are older ones" from length === limit, so a
    // box holding EXACTLY the page size was labelled definitely truncated. That
    // is a fabricated fact about someone's mailbox; hasOlder is now measured by
    // the caller (an over-fetch) and this renderer may not invent it.
    const out = renderInboxPage(page(MAIL_INBOX_DEFAULT_LIMIT), {
      showCommand: 'podium mail show',
      pageWasFull: false,
    })
    expect(out).not.toMatch(/older messages/i)
  })

  it('does not tell a truncated reader to ask for MORE output', () => {
    // Widening is the wrong recovery for a DISPLAY cut: it increases the output
    // that caused the loss. The route out is reading one message by id.
    const out = renderInboxPage(page(MAIL_INBOX_DEFAULT_LIMIT), {
      showCommand: 'podium mail show',
      pageWasFull: true,
    })
    const banner = out.split('\n').slice(0, 4).join('\n')
    expect(banner).toContain('podium mail show')
    expect(banner).not.toMatch(/--limit/)
  })

  it('THE SUPPORTED BOUND, asserted between the constants themselves [PDM-139]', () => {
    // The budget is claimed to hold a full page at the most degraded tier — one
    // id per line — plus the notices. That is a relationship between four
    // constants sitting in one file, and nothing stops a later edit raising the
    // page size or the id length and quietly breaking the guarantee this file
    // advertises. Assert the arithmetic, not just an example of it.
    const worstCase =
      MAIL_INBOX_MAX_LIMIT * (MAIL_INBOX_MAX_ID_BYTES + 1) + MAIL_INBOX_NOTICE_ALLOWANCE_BYTES
    expect(worstCase).toBeLessThanOrEqual(MAIL_INBOX_OUTPUT_BUDGET_BYTES)
    // And the floor really is one id per line: a header tier at full page does
    // NOT fit, which is why the id tier has to exist rather than being dead code.
    expect(MAIL_INBOX_MAX_LIMIT * (MAIL_INBOX_MAX_HEADER_CHARS + 1)).toBeGreaterThan(
      MAIL_INBOX_OUTPUT_BUDGET_BYTES,
    )
  })

  it('holds the bound at a REALISTIC maximum page, ids at full length [PDM-139]', () => {
    // The never-drop test above uses short ids; real ones are `msg_` + a uuid.
    // Sizing the fixture from the real population rather than convenience is the
    // exact lesson that produced this round of review.
    const entries = Array.from({ length: MAIL_INBOX_MAX_LIMIT }, (_, i) => {
      const id = `msg_${String(i).padStart(8, '0')}-0000-4000-8000-${'0'.repeat(12)}`
      // BYTES, not characters — the bound is a byte bound and a character count
      // cannot establish it. This is the shape both real producers emit.
      expect(utf8Len(id)).toBeLessThanOrEqual(MAIL_INBOX_MAX_ID_BYTES)
      return {
        id,
        header: `${id} issue:#212 -> issue:#228 t${i} [queued]`,
        body: longBody(`m${i}`, 400),
      }
    })
    const out = renderInboxPage(entries, { showCommand: 'podium mail show', pageWasFull: true })
    for (const e of entries) expect(out).toContain(e.id)
    expect(utf8Len(out)).toBeLessThanOrEqual(MAIL_INBOX_OUTPUT_BUDGET_BYTES)
  })

  it('names the id in EVERY tier, including a short header that omits it [PDM-139]', () => {
    // THE CASE THE CLIPPED TIER COULD NOT REACH. The renderer takes `header` from
    // its caller; an earlier version enforced the id only when clipping, so the
    // two richest tiers — the ones a normal inbox actually uses — rendered
    // whatever the caller supplied. A SHORT header omitting its id therefore
    // produced a page with no id for that row, with no oversized input anywhere
    // and nothing for a clipping test to catch.
    const entries = [
      { id: 'msg_aaa', header: 'from someone, no id here', body: 'short' },
      { id: 'msg_bbb', header: 'also no id', body: 'short' },
    ]
    // Tier 1 (full bodies) — the default path, comfortably inside the budget.
    const full = renderInboxPage(entries, { showCommand: 'podium mail show', pageWasFull: false })
    for (const e of entries) expect(full).toContain(e.id)
    // Tier 2 (previews), forced by a budget too small for full bodies.
    const preview = renderInboxPage(
      [
        { id: 'msg_aaa', header: 'no id', body: 'x'.repeat(4000) },
        { id: 'msg_bbb', header: 'no id', body: 'y'.repeat(4000) },
      ],
      { showCommand: 'podium mail show', pageWasFull: false, budgetBytes: 1200 },
    )
    expect(preview).toContain('msg_aaa')
    expect(preview).toContain('msg_bbb')
  })

  it('sizes the notice allowance for the declared show-command bound [PDM-139]', () => {
    // The head lines interpolate `showCommand`, so the allowance is only honest
    // if the command is bounded too. Both call sites pass `podium mail show`.
    expect(utf8Len('podium mail show')).toBeLessThanOrEqual(MAIL_INBOX_MAX_SHOW_COMMAND_BYTES)
    const head = renderInboxPage([{ id: 'm', header: 'm h', body: 'b' }], {
      showCommand: 'x'.repeat(MAIL_INBOX_MAX_SHOW_COMMAND_BYTES),
      pageWasFull: true,
    })
      .split('\n')
      .slice(0, 4)
      .join('\n')
    expect(utf8Len(head)).toBeLessThanOrEqual(MAIL_INBOX_NOTICE_ALLOWANCE_BYTES)
  })
})
