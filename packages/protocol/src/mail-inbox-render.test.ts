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
  MAIL_INBOX_MAX_LIMIT,
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

  it('is bounded BY CONSTRUCTION at the maximum page of maximum bodies', () => {
    // 32_768 is the send-path body cap, so this is the worst page that can
    // exist. A renderer bounded only by row count fails here by ~500x.
    const entries = page(MAIL_INBOX_MAX_LIMIT, 400)
    const out = renderInboxPage(entries, { showCommand: 'podium mail show', pageWasFull: true })
    expect(utf8Len(out)).toBeLessThanOrEqual(MAIL_INBOX_OUTPUT_BUDGET_BYTES)
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
})
