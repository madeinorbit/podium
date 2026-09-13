/**
 * `podium issue mail inbox` — WHICH END OF A LONG MAILBOX A READER GETS [PDM-407].
 *
 * This is the surface the epic coordinator actually reads its mail through, and
 * it is a SEPARATE transport from `podium mail inbox`: a different procedure
 * (`issues.mailInbox`), a different store method, its own renderer. Fixing the
 * other one does nothing here, which is why this file exists next to the
 * mail-cli suite rather than inside it.
 *
 * The failure it pins is not "too few rows". It is a listing that was UNBOUNDED
 * and ascending, so the cut fell to whatever displayed it — a terminal, an
 * agent's tool-output cap — and always took the tail. The newest mail was the
 * mail that vanished, while the unread count went on climbing.
 */
import { describe, expect, it, vi } from 'vitest'
import type { IssueTrpc } from './client.js'
import { ISSUE_COMMANDS } from './commands.js'

const mail = () => {
  const entry = ISSUE_COMMANDS.find((c) => c.name === 'mail')
  if (!entry) throw new Error('missing mail command')
  return entry
}

const row = (id: string) => ({
  id,
  fromAuthor: 'issue:#212',
  body: `body ${id}`,
  createdAt: `t-${id}`,
  status: 'unread',
  wasUnread: true,
})

function client(rows: unknown[]) {
  const mailInbox = vi.fn(async () => rows)
  return {
    trpc: { issues: { mailInbox: { mutate: mailInbox } } } as unknown as IssueTrpc,
    mailInbox,
  }
}

describe('podium issue mail inbox — page size and truncation', () => {
  it('asks for exactly the page it will show', async () => {
    const c = client([row('m1')])
    await mail().run(c.trpc, { sub: 'inbox', ref: '#107' })
    // 50, NOT 51. Over-fetching a probe row would measure hasOlder, but an inbox
    // read marks what it returns read, so the probe would be consumed unseen.
    expect(c.mailInbox).toHaveBeenLastCalledWith({ id: '#107', limit: 50 })
    await mail().run(c.trpc, { sub: 'inbox', ref: '#107', limit: 3 })
    expect(c.mailInbox).toHaveBeenLastCalledWith({ id: '#107', limit: 3 })
  })

  it('THE ACCEPTANCE WITNESS: the newest id survives a consumer cut [PDM-139]', async () => {
    // THIS renderer, not the shared helper in isolation — the reviewer's point
    // was that a store-level newest-page selection is credited separately from
    // display acceptance, and only the real renderer can answer the second.
    //
    // Long multiline bodies, because that is the defect: a page of fifty
    // messages averaging 3.7KB (the measured mean on the mailbox this issue was
    // filed from) is ~187KB against an inline cut observed near 214KB.
    const long = (tag: string) =>
      Array.from({ length: 40 }, (_, i) => `${tag} line ${i} ${'y'.repeat(80)}`).join('\n')
    const rows = Array.from({ length: 50 }, (_, i) => ({
      ...row(`m${String(i).padStart(2, '0')}`),
      body: long(`m${i}`),
    }))
    const out = await mail().run(client(rows).trpc, { sub: 'inbox', ref: '#107', limit: 50 })
    const text = (out as { text: string }).text

    // An explicit, brutal simulated consumer budget.
    const seen = Buffer.from(text, 'utf8').subarray(0, 2048).toString('utf8')
    expect(seen).toContain('m49')
    // …with an actionable full-read route, since an id you cannot act on is the
    // "count that names nothing readable" defect wearing a new costume.
    expect(seen).toContain('podium mail show')
    // BOTH DIRECTIONS: the oldest is what a cut is allowed to take.
    expect(seen).not.toContain('m00')
  })

  it('leaves a short mailbox in full, newest first, unmarked', async () => {
    // The admission: a renderer that always previewed, or always warned, would
    // satisfy the witness above and make every ordinary inbox worse.
    const out = await mail().run(client([row('m1'), row('m2')]).trpc, {
      sub: 'inbox',
      ref: '#107',
      limit: 3,
    })
    const text = (out as { text: string }).text
    expect(text).toContain('body m1')
    expect(text).not.toMatch(/Older messages exist/i)
    expect(text.indexOf('m2')).toBeLessThan(text.indexOf('m1'))

    const empty = await mail().run(client([]).trpc, { sub: 'inbox', ref: '#107', limit: 3 })
    expect((empty as { text: string }).text).toBe('(no mail)')
  })

  it('THE CONSUMING-BOUNDARY WITNESS: every read-marked row is named [PDM-139]', async () => {
    // Through the REAL consuming path. `issues.mailInbox` is a MUTATION: the rows
    // it returns are marked read server-side by the time this renderer runs. So
    // the accounting that matters is per-row and it is identity, not count —
    // every row the boundary handed back must appear, by id, in what the reader
    // sees. A row consumed with no id shown is unrecoverable, which is the same
    // reason an over-fetch probe was rejected.
    //
    // Maximum page, full-length ids, long multiline bodies: the worst case the
    // boundary can produce.
    const long = (tag: string) =>
      Array.from({ length: 60 }, (_, i) => `${tag} line ${i} ${'z'.repeat(90)}`).join('\n')
    // BEYOND THE SUPPORTED PAGE ON PURPOSE. At a supported page the id tier fits
    // the budget, so a renderer that drops rows never reaches its drop path and
    // this witness would pass vacuously — which it did, until a deliberate break
    // showed it could not fail for the reason it exists. Overshooting the bound
    // is the only way to exercise the floor through the REAL boundary, and the
    // never-drop guarantee is unconditional precisely so it still holds here.
    const returned = Array.from({ length: 1500 }, (_, i) => {
      const id = `msg_${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`
      return {
        id,
        fromAuthor: 'issue:#212',
        body: long(`m${i}`),
        createdAt: `2026-09-13T10:${String(i % 60).padStart(2, '0')}:00.000Z`,
        status: 'unread',
        wasUnread: true,
      }
    })
    const c = client(returned)
    const out = await mail().run(c.trpc, { sub: 'inbox', ref: '#107', limit: 500 })
    const text = (out as { text: string }).text

    // PER-ROW IDENTITY ACCOUNTING over everything the boundary consumed.
    const missing = returned.filter((m) => !text.includes(m.id)).map((m) => m.id)
    expect(missing).toEqual([])
    // Newest first, so an arbitrary downstream cut takes the OLDEST.
    expect(text.indexOf(returned[1499]!.id)).toBeLessThan(text.indexOf(returned[0]!.id))
    // And the newest id is reachable inside a brutal consumer budget, with a route.
    const seen = Buffer.from(text, 'utf8').subarray(0, 2048).toString('utf8')
    expect(seen).toContain(returned[1499]!.id)
    expect(seen).toContain('podium mail show')
  })
})
