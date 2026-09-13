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
  it('sends the cap explicitly so it can quote the one the server used', async () => {
    const c = client([row('m1')])
    await mail().run(c.trpc, { sub: 'inbox', ref: '#107' })
    // Sent even when the caller gave no --limit. A FULL page is how truncation
    // is detected, so a CLI that lets the server pick silently cannot tell a
    // capped page from a whole mailbox.
    expect(c.mailInbox).toHaveBeenLastCalledWith({ id: '#107', limit: 50 })
    await mail().run(c.trpc, { sub: 'inbox', ref: '#107', limit: 3 })
    expect(c.mailInbox).toHaveBeenLastCalledWith({ id: '#107', limit: 3 })
  })

  it('marks a FULL page truncated at BOTH ends, naming the end it kept', async () => {
    const c = client([row('m1'), row('m2'), row('m3')])
    const out = await mail().run(c.trpc, { sub: 'inbox', ref: '#107', limit: 3 })
    const lines = (out as { text: string }).text.split('\n')
    // AT THE TOP as well as the bottom, and that is the whole point rather than
    // a flourish: this listing is cut by its reader exactly when it is long, and
    // a footer is the first thing such a cut removes — so a footer alone goes
    // missing in precisely the case it exists to report.
    expect(lines[0]).toMatch(/TRUNCATED/)
    expect(lines.at(-1)).toMatch(/--limit/)
    expect((out as { text: string }).text.match(/TRUNCATED/g)).toHaveLength(2)
    // WHICH end was kept. Without it a reader cannot tell whether the mail it is
    // missing is older or newer than what it can see, which is the question.
    expect((out as { text: string }).text).toMatch(/newest/i)
  })

  it('leaves a page shorter than the cap unmarked, and an empty box alone', async () => {
    // The admission that pairs with the notice above: without it, a renderer
    // that printed the banner unconditionally would satisfy the test above.
    const short = await mail().run(c1().trpc, { sub: 'inbox', ref: '#107', limit: 3 })
    expect((short as { text: string }).text).not.toMatch(/TRUNCATED/)
    expect((short as { text: string }).text).toContain('m1')

    const empty = await mail().run(client([]).trpc, { sub: 'inbox', ref: '#107', limit: 3 })
    expect((empty as { text: string }).text).toBe('(no mail)')
  })
})

const c1 = () => client([row('m1')])
