/**
 * POD-6295: `update --description|--brief` sends the revision the edit was
 * cut from, so a task another member changed since refuses the write instead
 * of losing their text. The refusal names the current revision.
 */
import { describe, expect, it, vi } from 'vitest'
import type { IssueTrpc } from './client.js'
import { ISSUE_COMMANDS } from './commands.js'

const update = ISSUE_COMMANDS.find((c) => c.name === 'update')!

function client(mutate: (input: unknown) => Promise<unknown>) {
  const spy = vi.fn(mutate)
  return { trpc: { issues: { update: { mutate: spy } } } as unknown as IssueTrpc, spy }
}

describe('update --expected-revision', () => {
  it('sends the revision with a description or brief edit', async () => {
    const c = client(async () => ({ seq: 7 }))
    const args = update.args.parse({ id: '7', brief: 'v2', expectedRevision: '4' })
    await update.run(c.trpc, args)
    expect(c.spy).toHaveBeenCalledWith({ id: '7', patch: { brief: 'v2' }, expectedRevision: 4 })
  })

  it('sends none when the flag is absent', async () => {
    const c = client(async () => ({ seq: 7 }))
    await update.run(c.trpc, update.args.parse({ id: '7', description: 'v2' }))
    expect(c.spy).toHaveBeenCalledWith({ id: '7', patch: { description: 'v2' } })
  })

  it('a stale revision is refused with the current one', async () => {
    const refusal =
      'issues.update expected revision 4 of issue iss_1, but it is at revision 6 - the issue changed since you read it. Re-read it and retry.'
    const c = client(async () => {
      throw new Error(refusal)
    })
    await expect(
      update.run(c.trpc, update.args.parse({ id: '7', description: 'v2', expectedRevision: 4 })),
    ).rejects.toThrow('it is at revision 6')
  })
})
