/**
 * D8 (POD-6101): an agent sees the acceptance criteria in prime, and again when
 * it hands the issue off — `update --stage review|done` or `close` as done.
 */
import { describe, expect, it, vi } from 'vitest'
import type { IssueTrpc } from './client.js'
import { ISSUE_COMMANDS } from './commands.js'

const ACCEPTANCE = 'The deck reads "Read more".'

function client(acceptance: string | null = ACCEPTANCE) {
  const row = { seq: 7, acceptance }
  const updateMutate = vi.fn(async () => row)
  const closeMutate = vi.fn(async () => row)
  return {
    trpc: {
      issues: { update: { mutate: updateMutate }, close: { mutate: closeMutate } },
    } as unknown as IssueTrpc,
    updateMutate,
    closeMutate,
  }
}

const command = (name: string) => {
  const entry = ISSUE_COMMANDS.find((c) => c.name === name)
  if (!entry) throw new Error(`missing ${name} command`)
  return entry
}

const text = async (name: string, c: ReturnType<typeof client>, a: Record<string, unknown>) =>
  ((await command(name).run(c.trpc, a)) as { text: string }).text

describe('acceptance at handoff', () => {
  it.each([
    'review',
    'done',
  ])('update --stage %s repeats the acceptance criteria', async (stage) => {
    const out = await text('update', client(), { id: '7', stage })
    expect(out).toBe(`updated #7\nAcceptance — confirm it is met:\n${ACCEPTANCE}`)
  })

  it('other updates stay one line', async () => {
    expect(await text('update', client(), { id: '7', stage: 'in_progress' })).toBe('updated #7')
    expect(await text('update', client(), { id: '7', title: 'New title' })).toBe('updated #7')
  })

  it('an issue without acceptance prints nothing extra', async () => {
    expect(await text('update', client(null), { id: '7', stage: 'review' })).toBe('updated #7')
    expect(await text('update', client('  '), { id: '7', stage: 'review' })).toBe('updated #7')
  })

  it('close as done repeats it; a cancel does not', async () => {
    expect(await text('close', client(), { id: '7' })).toContain(ACCEPTANCE)
    expect(await text('close', client(), { id: '7', reason: 'done' })).toContain(ACCEPTANCE)
    expect(await text('close', client(), { id: '7', reason: 'cancelled' })).toBe('closed #7')
  })
})

describe('design and notes are gone', () => {
  it.each(['design', 'notes'])('update refuses --%s', (flag) => {
    const update = command('update')
    expect(update.args.safeParse({ id: '7', [flag]: 'x' }).success).toBe(false)
  })
})
