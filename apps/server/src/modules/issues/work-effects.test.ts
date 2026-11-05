/**
 * THE ISSUE COMMANDS THAT ACT ON MACHINES, AS EFFECT RECORDS (POD-6414).
 *
 * Start, stop, add a session or a shell, clean up, ship and refresh the
 * assistant: each old command creates a record of its kind through the sync
 * write entry point, as its caller, and answers once it settles, with the old
 * answer or the old error. The record runs the family's own handler once, as
 * the writer as they are now.
 */

import { asIssueId, asUserId } from '@podium/model'
import { TRPCError } from '@trpc/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { userCommandPrincipal } from '../../command-principal'
import { disposeOracles, makeOracle as makeBareOracle } from '../sessions/oracle-support'
import { type AnyIssueCommandDef, issueRegistry } from './registry'
import { ISSUE_WORK_EFFECT_KIND, type IssueWorkCommand } from './work-effects'

afterEach(() => disposeOracles())

async function makeOracle() {
  const o = await makeBareOracle()
  await o.store.repos.addRepo('/r', o.store.hostMachineId)
  return o
}

async function newIssue(o: Awaited<ReturnType<typeof makeOracle>>, title: string) {
  return await o.reg.issues.crud.create({ repoPath: '/r', title, startNow: false })
}

describe('the issue work effects', () => {
  it('every command that acts on machines has its kind registered', async () => {
    const o = await makeOracle()
    const kinds = o.reg.modules.effects?.executors.kinds() ?? []
    for (const name of Object.keys(ISSUE_WORK_EFFECT_KIND) as IssueWorkCommand[]) {
      expect(kinds, name).toContain(ISSUE_WORK_EFFECT_KIND[name])
    }
  })

  it('the old stop creates a record through the entry point and answers its old shape', async () => {
    const o = await makeOracle()
    const issue = await newIssue(o, 'nothing running')
    const entry = vi.spyOn(o.reg.modules.syncWrite, 'submitDetailed')

    const answer = await o.call.issues.stop({ id: issue.id })

    expect(answer).toMatchObject({ ok: true, stopped: [] })
    expect(
      entry.mock.calls.map(([env]) => [env.command, (env.input as { kind: string }).kind]),
    ).toEqual([['effects.create', 'issue.stop']])
    const record = await o.store.effects.newestOnTarget(
      'issue.stop',
      { kind: 'issue', id: issue.id },
      'succeeded',
    )
    expect(record).toMatchObject({ status: 'succeeded', attempts: 1 })
  })

  it("a handler's refusal answers as the refusal it always was", async () => {
    const o = await makeOracle()
    const issue = await newIssue(o, 'never started')

    await expect(o.call.issues.addSession({ id: issue.id })).rejects.toThrow('issue not started')
    const record = await o.store.effects.newestOnTarget(
      'issue.addSession',
      { kind: 'issue', id: issue.id },
      'active',
    )
    // Settled, not left waiting: the failed record is no longer active.
    expect(record).toBeUndefined()
  })

  it('the handler runs once per record, as the inline command would have', async () => {
    const o = await makeOracle()
    const issue = await newIssue(o, 'counted')
    const run = vi.spyOn(o.reg.issues.gitWorkflow, 'cleanup')

    await o.call.issues.cleanup({ id: issue.id }).catch(() => {})
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0]?.[0]).toBe(issue.id)
  })

  it('an unknown issue answers as it always did: not found', async () => {
    const o = await makeOracle()
    const error = await o.call.issues
      .cleanup({ id: asIssueId('iss_nope') })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(TRPCError)
    expect((error as TRPCError).code).toBe('NOT_FOUND')
  })

  it("a caller refused at create (a member, someone else's issue) gets no record and no run", async () => {
    const o = await makeOracle()
    const issue = await newIssue(o, 'not theirs')
    const member = asUserId('usr_member_6414')
    await o.store.users.createUnclaimed({
      id: member,
      displayName: 'Member',
      email: null,
      role: 'member',
      createdAt: new Date().toISOString(),
      disabledAt: null,
    })
    const principal = userCommandPrincipal(member, 'member')
    const run = vi.spyOn(o.reg.issues.gitWorkflow, 'cleanup')
    const def = (issueRegistry.defs as Record<string, AnyIssueCommandDef>)
      .cleanup as AnyIssueCommandDef

    await expect(
      o.reg.issueCommands.run({ capability: principal.capability, principal }, 'cleanup', def, {
        id: issue.id,
      }),
    ).rejects.toThrow()
    expect(run).not.toHaveBeenCalled()
    expect(
      await o.store.effects.newestOnTarget(
        'issue.cleanup',
        { kind: 'issue', id: issue.id },
        'active',
      ),
    ).toBeUndefined()
  })

  it('a record whose run the server lost says so instead of guessing', async () => {
    const o = await makeOracle()
    const executor = o.reg.modules.effects?.executors.get('issue.stop')
    const outcome = await executor?.recover?.({} as never)
    expect(outcome).toMatchObject({ status: 'unknown', error: { code: 'lost-track' } })
  })
})
