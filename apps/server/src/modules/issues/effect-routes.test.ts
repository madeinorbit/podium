/**
 * THE ISSUE COMMANDS THAT ACT ON MACHINES OR GIT, ON THE ONE WRITE PATH
 * (POD-6603, ADR 12 D2/D9).
 *
 * Start, add a session or a shell, stop, clean up, ship, refresh the assistant,
 * answer the Tray's question, the git actions and integrate: each command's
 * write is an effect record, created through `effects.create` on `sync.submit`.
 * For each: the record arrives through `sync.submit` with its provenance and a
 * receipt at the head; a replay answers the recorded result and runs nothing;
 * the target check refuses a member whose grant on the issue was revoked. The
 * old route is an adapter onto `effects.create`, and none is left in the
 * direct-write census. With no daemon to run it, the old command is refused at
 * once and creates nothing: it never does the work itself.
 */

import { asMachineId, asUserId, firstAdminMemberId, mintDeviceId } from '@podium/model'
import type { SyncSubmitInput } from '@podium/protocol'
import type { AnyProcedure } from '@trpc/server'
import { TRPCError } from '@trpc/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { userCommandPrincipal } from '../../command-principal'
import { appRouter } from '../../router'
import type { RouteMeta } from '../../trpc'
import {
  disposeOracles,
  makeOracle as makeBareOracle,
  type Oracle,
  waitFor,
} from '../sessions/oracle-support'
import { appliedReply, envelope, head, rowsOf, submit } from '../sync-write/outbox-test-support'
import { DIRECT_WRITES } from '../write-routes/direct'
import { ISSUE_EFFECT_RECORD_COMMANDS } from './work-effects'

afterEach(() => disposeOracles())

const OFFLINE = asMachineId('mach_offline_6603')

async function makeOracle() {
  const o = await makeBareOracle({ offlineMachines: [{ id: OFFLINE, name: 'Away' }] })
  await o.store.repos.addRepo('/r', o.store.hostMachineId)
  return o
}

/** The fixture's own writes (setup, not the commands under test). */
const w = (o: Oracle) => o.reg.issues.reports.store.serverWriter

async function newIssue(o: Oracle, title: string) {
  const issue = await o.reg.issues.crud.create(w(o), { repoPath: '/r', title, startNow: false })
  const slug = title.replace(/\W+/g, '-')
  // Started, so a session or a shell has a worktree to join.
  await o.reg.issues.crud.update(w(o), issue.id, {
    worktreePath: `/r/.worktrees/${slug}`,
    branch: `issue/${slug}`,
  })
  return issue
}

interface CommandCase {
  /** The record's kind. */
  readonly kind: string
  /** The record's input. */
  readonly input: () => Record<string, unknown>
}

const sessionId = () => ({ sessionId: crypto.randomUUID() })

/** Every issue command whose write is an effect record, with its record. */
const CASES: Readonly<Record<string, CommandCase>> = {
  start: { kind: 'issue.begin', input: sessionId },
  addSession: { kind: 'issue.addSession', input: sessionId },
  addShell: { kind: 'issue.addSession', input: () => ({ shell: true, ...sessionId() }) },
  stop: { kind: 'issue.stop', input: () => ({}) },
  cleanup: { kind: 'issue.cleanup', input: () => ({}) },
  ship: { kind: 'issue.ship', input: () => ({}) },
  refreshAssistant: { kind: 'issue.assistant', input: () => ({}) },
  answerQuestion: { kind: 'session.answer', input: () => ({ via: 'issue', text: 'yes' }) },
  action: { kind: 'issue.merge', input: () => ({}) },
  integrate: { kind: 'issue.integrate', input: () => ({}) },
}

const recordEnvelope = (
  name: string,
  issueId: string,
  effectId: string,
  mutationId: string,
): SyncSubmitInput => {
  const c = CASES[name] as CommandCase
  return envelope(
    'effects.create',
    { id: effectId, kind: c.kind, target: { kind: 'issue', id: issueId }, input: c.input() },
    mutationId,
  )
}

async function settled(o: Oracle, id: string) {
  await waitFor(async () => {
    const status = (await o.store.effects.get(id))?.status
    return status !== undefined && status !== 'pending' && status !== 'running'
  }, `effect ${id} to settle`)
  await o.reg.modules.effects?.runner.idle()
  return await o.store.effects.get(id)
}

async function member(o: Oracle, id: string) {
  const user = asUserId(id)
  await o.store.users.createUnclaimed({
    id: user,
    displayName: id,
    email: null,
    role: 'member',
    createdAt: new Date().toISOString(),
    disabledAt: null,
  })
  return user
}

const grant = (issueId: string, grantee: string) => ({
  resourceKind: 'issue' as const,
  resourceId: issueId,
  grantee: asUserId(grantee),
  verb: 'write' as const,
  owner: firstAdminMemberId(),
  visibility: 'personal' as const,
  createdAt: new Date().toISOString(),
  actorKind: 'user' as const,
  actorId: firstAdminMemberId(),
  onBehalfOf: firstAdminMemberId(),
})

describe('the cases cover every effect-record issue command', () => {
  it('one case per command, none in the direct-write census, its route on effects.create', () => {
    expect(Object.keys(CASES).sort()).toEqual([...ISSUE_EFFECT_RECORD_COMMANDS].sort())
    const procedures = appRouter._def.procedures as unknown as Record<string, AnyProcedure>
    for (const name of ISSUE_EFFECT_RECORD_COMMANDS) {
      expect(Object.hasOwn(DIRECT_WRITES, `issues.${name}`), name).toBe(false)
      expect(procedures[`issues.${name}`]?._def.meta as RouteMeta, name).toEqual({
        registration: 'effects.create',
        path: 'sync',
      })
    }
    expect(Object.keys(DIRECT_WRITES).filter((name) => name.startsWith('issues.'))).toEqual([])
  })
})

describe.each(Object.keys(CASES))('issues.%s on sync.submit', (name) => {
  it('provenance, the receipt at the head, and a replay runs nothing', async () => {
    const o = await makeOracle()
    const issue = await newIssue(o, `${name} on path`)
    const effectId = mintDeviceId('eff_')
    const env = recordEnvelope(name, issue.id, effectId, `m-${name}-path`)
    const executor = o.reg.modules.effects?.executors.get(CASES[name]?.kind as string)
    const run = vi.spyOn(executor as NonNullable<typeof executor>, 'run')

    const reply = appliedReply(await submit(o, env))
    expect(reply.replayed).not.toBe(true)
    const rows = await rowsOf(o, env.mutationId)
    const record = rows.filter((row) => row.entityId === effectId)
    expect(record.length).toBeGreaterThan(0)
    for (const row of record) expect(row.causationId).toBe(env.mutationId)
    const newest = Math.max(...record.map((row) => row.seq))
    expect(reply.receipt.seq).toBeGreaterThanOrEqual(newest)
    expect(reply.receipt.seq).toBeLessThanOrEqual(await head(o))

    const first = await settled(o, effectId)
    expect(first?.attempts).toBe(1)
    expect(run).toHaveBeenCalledTimes(1)
    const written = (await rowsOf(o, env.mutationId)).length

    const replay = appliedReply(await submit(o, env))
    expect(replay.replayed).toBe(true)
    expect(JSON.stringify(replay.result ?? null)).toBe(JSON.stringify(reply.result ?? null))
    await o.reg.modules.effects?.runner.idle()
    expect(run).toHaveBeenCalledTimes(1)
    expect((await o.store.effects.get(effectId))?.attempts).toBe(1)
    expect((await rowsOf(o, env.mutationId)).length).toBe(written)
  })

  it('the target check refuses a member whose grant on the issue was revoked', async () => {
    const o = await makeOracle()
    const issue = await newIssue(o, `${name} granted`)
    const user = await member(o, `usr_grantee_${name}_6603`)
    const principal = userCommandPrincipal(user, 'member')
    const asMember = async (env: SyncSubmitInput) =>
      await o.reg.modules.syncWrite.submit(env, principal, 'trpc')

    // Without a grant, the issue is not theirs: refused before any record.
    const before = await asMember(
      recordEnvelope(name, issue.id, mintDeviceId('eff_'), `m-${name}-0`),
    )
    expect(before.outcome).toBe('rejected')

    await o.store.grants.upsert(grant(issue.id, user))
    const granted = recordEnvelope(name, issue.id, mintDeviceId('eff_'), `m-${name}-1`)
    appliedReply(await asMember(granted))
    await o.reg.modules.effects?.runner.idle()

    await o.store.grants.remove('issue', issue.id, user, 'write')
    const replay = await asMember(granted)
    expect(replay.outcome).toBe('rejected')
    const fresh = await asMember(
      recordEnvelope(name, issue.id, mintDeviceId('eff_'), `m-${name}-2`),
    )
    expect(fresh.outcome).toBe('rejected')
  })
})

describe('with no daemon to run it, the old command creates nothing and never does the work', () => {
  const pinnedAway = async (o: Oracle, title: string, started: boolean) => {
    const issue = started
      ? await newIssue(o, title)
      : await o.reg.issues.crud.create(w(o), { repoPath: '/r', title, startNow: false })
    await o.reg.issues.crud.update(w(o), issue.id, { machineId: OFFLINE })
    return issue
  }

  /** The record path and the work, watched: neither may run. */
  const watch = (o: Oracle) => {
    const workflow = o.reg.issues.gitWorkflow
    const entry = vi.spyOn(o.reg.modules.syncWrite, 'submitDetailed')
    const work = [
      vi.spyOn(workflow, 'start'),
      vi.spyOn(workflow, 'addSession'),
      vi.spyOn(workflow, 'addShell'),
      vi.spyOn(workflow, 'cleanup'),
      vi.spyOn(o.reg.shipping, 'enqueueCurrent'),
    ]
    return async (name: keyof typeof CASES, issueId: string) => {
      expect(entry).not.toHaveBeenCalled()
      for (const spy of work) expect(spy).not.toHaveBeenCalled()
      expect(
        await o.store.effects.newestOnTarget(
          CASES[name]?.kind as string,
          { kind: 'issue', id: issueId },
          'active',
        ),
      ).toBeUndefined()
    }
  }

  const closeIt = async (o: Oracle, id: string) =>
    await o.reg.issues.crud.update(w(o), id, { stage: 'done', closedReason: 'done' })

  it.each([
    'start',
    'addSession',
    'addShell',
    'cleanup',
    'ship',
  ] as const)('%s with work for the machine: refused, naming the machine', async (name) => {
    const o = await makeOracle()
    const issue = await pinnedAway(o, `${name} away`, true)
    // A cleanup has machine work only on a closed issue with a worktree.
    if (name === 'cleanup') await closeIt(o, issue.id)
    const nothingRan = watch(o)

    const error = await o.call.issues[name]({ id: issue.id }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(TRPCError)
    expect((error as TRPCError).code).toBe('PRECONDITION_FAILED')
    expect((error as TRPCError).message).toContain("machine 'Away' is offline")
    await nothingRan(name, issue.id)
  })

  it('a start of an already-started issue stays a no-op: its projection', async () => {
    const o = await makeOracle()
    const issue = await pinnedAway(o, 'started away', true)
    const wt = (await o.reg.issues.reports.get(issue.id))?.worktreePath as string
    await o.reg.modules.sessions.createSession({ cwd: wt, agentKind: 'shell', issueId: issue.id })
    const nothingRan = watch(o)

    const answer = await o.call.issues.start({ id: issue.id })

    expect(answer).toMatchObject({ id: issue.id, worktreePath: wt })
    await nothingRan('start', issue.id)
    // An explicit model asks for what the no-op will not do: refused, as always.
    await expect(o.call.issues.start({ id: issue.id, defaultModel: 'opus' })).rejects.toThrow(
      'is already started',
    )
  })

  it("a cleanup with nothing to do answers its own `ok: false`, not the machine's", async () => {
    const o = await makeOracle()
    const open = await pinnedAway(o, 'open away', true)
    const bare = await pinnedAway(o, 'bare away', false)
    await closeIt(o, bare.id)
    const nothingRan = watch(o)

    expect(await o.call.issues.cleanup({ id: open.id })).toMatchObject({
      ok: false,
      output: expect.stringContaining('is still open'),
      issue: { id: open.id },
    })
    expect(await o.call.issues.cleanup({ id: bare.id })).toMatchObject({
      ok: false,
      output: expect.stringContaining('nothing to clean up'),
    })
    await nothingRan('cleanup', open.id)
    await nothingRan('cleanup', bare.id)
  })

  it("a session on an issue never started answers the command's own refusal first", async () => {
    const o = await makeOracle()
    const issue = await pinnedAway(o, 'not started away', false)
    const nothingRan = watch(o)
    await expect(o.call.issues.addSession({ id: issue.id })).rejects.toThrow('issue not started')
    await expect(o.call.issues.addShell({ id: issue.id })).rejects.toThrow('issue not started')
    await nothingRan('addSession', issue.id)
  })

  it('a stop needs no daemon: it takes the record path', async () => {
    const o = await makeOracle()
    // Never started: no worktree to free on the machine that is away.
    const issue = await pinnedAway(o, 'stop away', false)
    const entry = vi.spyOn(o.reg.modules.syncWrite, 'submitDetailed')
    await o.call.issues.stop({ id: issue.id })
    expect(entry.mock.calls[0]?.[0].command).toBe('effects.create')
  })
})
