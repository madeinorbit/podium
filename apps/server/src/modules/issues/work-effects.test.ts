/**
 * THE ISSUE COMMANDS THAT ACT ON MACHINES, AS EFFECT RECORDS (POD-6414).
 *
 * Start, stop, add a session or a shell, clean up, ship and refresh the
 * assistant: each old command creates a record of its kind through the sync
 * write entry point, as its caller, and answers once it settles, with the old
 * answer or the old error. The record runs the family's own handler once, as
 * the writer as they are now.
 */

import {
  asIssueId,
  asUserId,
  firstAdminMemberId,
  mintDeviceId,
  type SessionId,
} from '@podium/model'
import { fixtureWriteScope } from '@podium/sync/testing'
import { TRPCError } from '@trpc/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { userCommandPrincipal } from '../../command-principal'
import {
  disposeOracles,
  makeOracle as makeBareOracle,
  type Oracle,
  waitFor,
} from '../sessions/oracle-support'
import { appliedReply, envelope, submit } from '../sync-write/outbox-test-support'
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

  it('a stop the server lost with its worktree still there says so instead of guessing', async () => {
    const o = await makeOracle()
    const issue = await startedIssue(o, 'lost stop')
    const executor = o.reg.modules.effects?.executors.get('issue.stop')
    const record = { id: 'eff_x', target: { kind: 'issue', id: issue.id } }
    const outcome = await executor?.recover?.({ record, input: {} } as never)
    expect(outcome).toMatchObject({ status: 'unknown', error: { code: 'lost-track' } })
  })
})

// ---------------------------------------------------------------------------
// Spawns: once per session id, the writer re-checked, nothing on a rollback
// ---------------------------------------------------------------------------

async function startedIssue(o: Oracle, title: string) {
  const issue = await newIssue(o, title)
  const slug = title.replace(/\W+/g, '-')
  await o.reg.issues.crud.update(issue.id, {
    worktreePath: `/r/.worktrees/${slug}`,
    branch: `issue/${slug}`,
  })
  return issue
}

const newSessionId = () => crypto.randomUUID() as SessionId

const spawns = (o: Oracle, id: string) =>
  o.daemon.filter((m) => m.type === 'spawn' && (m as { sessionId?: string }).sessionId === id)

async function settled(o: Oracle, id: string) {
  await waitFor(async () => {
    const status = (await o.store.effects.get(id))?.status
    return status !== undefined && status !== 'pending' && status !== 'running'
  }, `effect ${id} to settle`)
  return await o.store.effects.get(id)
}

const addShellEnvelope = (effectId: string, issueId: string, sessionId: string, m: string) =>
  envelope(
    'effects.create',
    {
      id: effectId,
      kind: 'issue.addSession',
      target: { kind: 'issue', id: issueId },
      input: { shell: true, sessionId },
    },
    m,
  )

describe('issue.addSession and issue.begin spawn once per session id', () => {
  it('a record spawns its session once; a replay and a second record for the id spawn nothing', async () => {
    const o = await makeOracle()
    const issue = await startedIssue(o, 'one shell')
    const sessionId = newSessionId()
    const first = mintDeviceId('eff_')
    const env = addShellEnvelope(first, issue.id, sessionId, 'as-1')

    appliedReply(await submit(o, env))
    expect(await settled(o, first)).toMatchObject({ status: 'succeeded' })
    expect(spawns(o, sessionId)).toHaveLength(1)

    expect(appliedReply(await submit(o, env)).replayed).toBe(true)
    const second = mintDeviceId('eff_')
    appliedReply(await submit(o, addShellEnvelope(second, issue.id, sessionId, 'as-2')))
    expect(await settled(o, second)).toMatchObject({
      status: 'succeeded',
      result: { sessionId, output: 'already started' },
    })
    await o.reg.modules.effects?.runner.idle()
    expect(spawns(o, sessionId)).toHaveLength(1)
  })

  it('a record written in a unit of work that rolls back spawns nothing; committed, it spawns once', async () => {
    const o = await makeOracle()
    const issue = await startedIssue(o, 'rolled back')
    const sessionId = newSessionId()
    const record = (id: string) => ({
      id,
      kind: 'issue.addSession',
      target: { kind: 'issue' as const, id: issue.id },
      input: { shell: true, sessionId },
      deadlineAt: undefined,
      createdBy: firstAdminMemberId(),
    })
    await expect(
      o.store.transact(async () => {
        await o.store.effects.insert(fixtureWriteScope(), record(mintDeviceId('eff_')), Date.now())
        throw new Error('roll back')
      }),
    ).rejects.toThrow('roll back')
    await o.reg.modules.effects?.runner.idle()
    expect(spawns(o, sessionId)).toHaveLength(0)

    const committed = mintDeviceId('eff_')
    await o.store.effects.insert(fixtureWriteScope(), record(committed), Date.now())
    await o.reg.modules.effects?.runner.poke('issue.addSession')
    expect(await settled(o, committed)).toMatchObject({ status: 'succeeded' })
    expect(spawns(o, sessionId)).toHaveLength(1)
  })

  it('a writer whose account was disabled since is refused at run time and spawns nothing', async () => {
    const o = await makeOracle()
    const issue = await startedIssue(o, 'writer gone')
    const gone = asUserId('usr_gone_6414')
    await o.store.users.createUnclaimed({
      id: gone,
      displayName: 'Gone',
      email: null,
      role: 'admin',
      createdAt: new Date().toISOString(),
      disabledAt: new Date().toISOString(),
    })
    const sessionId = newSessionId()
    const id = mintDeviceId('eff_')
    await o.store.effects.insert(
      fixtureWriteScope(),
      {
        id,
        kind: 'issue.begin',
        target: { kind: 'issue', id: issue.id },
        input: { sessionId },
        deadlineAt: undefined,
        createdBy: gone,
      },
      Date.now(),
    )
    await o.reg.modules.effects?.runner.poke('issue.begin')
    expect(await settled(o, id)).toMatchObject({ status: 'failed', error: { code: 'refused' } })
    expect(spawns(o, sessionId)).toHaveLength(0)
  })

  it('the old addShell answers its old shape, through an issue.addSession record', async () => {
    const o = await makeOracle()
    const issue = await startedIssue(o, 'old shell')
    const entry = vi.spyOn(o.reg.modules.syncWrite, 'submitDetailed')

    const answer = await o.call.issues.addShell({ id: issue.id })

    expect(answer).toMatchObject({ id: issue.id })
    const created = entry.mock.calls
      .map(([env]) => env)
      .filter((env) => env.command === 'effects.create')
    expect(created.map((env) => (env.input as { kind: string }).kind)).toEqual(['issue.addSession'])
    const sessionId = (created[0]?.input as { input: { sessionId: string } }).input.sessionId
    expect(spawns(o, sessionId)).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Stop: desired `stopped` on each member, then the worktree
// ---------------------------------------------------------------------------

describe('issue.stop', () => {
  it('stops each member by writing its desired state, never through the stop service', async () => {
    const o = await makeOracle()
    const issue = await startedIssue(o, 'two members')
    const wt = (await o.reg.issues.reports.get(issue.id))?.worktreePath as string
    const member = (
      await o.reg.modules.sessions.createSession({
        cwd: wt,
        agentKind: 'shell',
        issueId: asIssueId(issue.id),
      })
    ).sessionId
    const entry = vi.spyOn(o.reg.modules.syncWrite, 'submitDetailed')
    const service = vi.spyOn(o.reg.modules.issueSessionLifecycle, 'stopIssue')
    const free = vi.spyOn(o.reg.issues.gitWorkflow, 'freeWorktreeKeepBranch')

    const answer = await o.call.issues.stop({ id: issue.id })

    expect(answer).toMatchObject({ ok: true, stopped: [member] })
    expect(service).not.toHaveBeenCalled()
    const commands = entry.mock.calls.map(([env]) => env.command)
    expect(commands).toEqual(['effects.create', 'records.session.edit'])
    expect(entry.mock.calls[1]?.[0].input).toMatchObject({
      id: member,
      patch: { desired: 'stopped' },
    })
    const row = await o.reg.modules.sessions.desiredStateOf(member)
    expect(row?.lifecycle).toMatchObject({ desired: 'stopped' })
    expect(row?.lifecycle.observedRevision).toBe(row?.lifecycle.revision)
    expect(row?.status).toMatch(/hibernated|exited/)
    // Then the worktree, once nothing runs in it: the member's own stop frees it
    // and the final pass asks again, as the old stopIssue did.
    expect(free).toHaveBeenCalled()
    expect(free.mock.calls.at(-1)?.[0]).toBe(issue.id)
  })
})
