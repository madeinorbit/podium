/**
 * THE FILE READS ASK WHO IS CALLING [PDM-272].
 *
 * THE DEFECT THIS PINS IS A DISCLOSURE, NOT A THROW, and the three arms failed
 * three different ways:
 *
 *  - `read`'s `sessionId` arm matched neither `'artifactId' in input` nor
 *    `'root' in input` and fell through to the daemon with NO CHECK OF ANY KIND,
 *    while `sessions.transcriptRead` asserted ownership for the same session's
 *    bytes one module away. That asymmetry is the whole finding, so this file
 *    asserts BOTH HALVES OF IT in one place — `transcriptReadRefused` and
 *    `readSessionFileRefused` run the two procedures over one fixture. A future
 *    edit that re-opens either door reddens here by name.
 *  - `read`'s `artifactId` arm served `artifacts.read(issueId, …)` for any issue
 *    id the caller could name.
 *  - `read`'s `root` arm, `list` and `search` ran `assertAllowedRoot` alone:
 *    "is this a known repository path", which is containment and answers nothing
 *    about the caller.
 *
 * SO THE NEGATIVES ASSERT ABSENCE OF THE EFFECT, not just presence of an error
 * (catalogue #19, and `queries.status-authz.test.ts`'s rule). A test that only
 * checked `rejects.toThrow` would pass against a version that read the file,
 * walked the directory or shelled `git ls-files` on someone else's machine and
 * threw on the way out — which is disclosure with a tidy return code. `rpcCalls`
 * and `artifactReads` below are the real observation: a refused read must reach
 * NEITHER the daemon NOR the artifact store.
 *
 * THE FIXTURE'S STRANGER HOLDS NO CAPABILITY OF CONSEQUENCE (catalogue #14).
 * Collapsing the stranger into an admin, or into the owner, would let every
 * assertion here be decided by something other than the rule under test. OWNER,
 * GRANTEE and STRANGER are three distinct identities for the same reason
 * `queries.status-authz.test.ts` keeps them apart: a bare `owner === caller`
 * check would otherwise pass every assertion and the grant arm would go
 * untested.
 *
 * THE GATE IS REAL. `fileAccessGate` is constructed, not stubbed — only the
 * modules beneath it are fixtures. "The stranger got nothing" is therefore a
 * fact about the shipped decision path rather than about a mock's call log,
 * which catalogue #20 is explicit is worth nothing: a test that mocks the
 * permission call covers nothing about the permission.
 */

import {
  asMachineId,
  asSessionId,
  asUserId,
  type Capability,
  type MachineId,
  type SessionId,
  type UserId,
} from '@podium/model'
import { TRPCError } from '@trpc/server'
import { describe, expect, it } from 'vitest'
import type { CommandPrincipal } from '../../command-principal'
import type { FamilyState } from '../derived-family'
import { SESSION_QUERIES } from '../sessions/queries'
import { fileAccessGate, type FileAccessModules } from './file-access-gate'
import { FILE_QUERIES } from './queries'
import type { FileState } from './registry'

const OWNER = asUserId('u_owner')
const GRANTEE = asUserId('u_grantee')
/** Neither the owner nor a grantee, and not an admin. The only thing that can
 *  allow or refuse this identity is the ownership rule under test. */
const STRANGER = asUserId('u_stranger')

const TARGET = asSessionId('s_target')
const ROOT = '/repos/alpha'
const MACHINE = asMachineId('m_alpha')
const ISSUE = 'iss_alpha'

/**
 * A REAL capability, for one person, scoped to what they own.
 *
 * `role` is one of the model's three (`viewer | worker | admin`) rather than a
 * plausible-looking literal — an invented role makes `ROLE_ACTIONS[cap.role]`
 * undefined and every case here fails on a TypeError instead of a decision,
 * which is a fixture deciding the test for the wrong reason (catalogue #14).
 *
 * `scope.kind` is `owned` and NOT `all`. The operator's `all` returns early in
 * `checkIssueAccess` before the target is ever read, so a fixture built on it
 * would assert the artifact rule while never running it.
 */
const capabilityFor = (userId: UserId): Capability =>
  ({
    role: 'worker',
    scope: { kind: 'owned', userId },
    onBehalfOf: userId,
  }) as unknown as Capability


function harness(opts?: {
  owners?: Record<string, { owner: UserId; grants: UserId[] }>
  /** Machines this fixture's ownership index reports, and who may use them. */
  machineOwner?: UserId
  /** Grant edges on the machine, so the see/use split can be exercised. */
  machineGrants?: { grantee: string; verb: string }[]
  roots?: string[]
}) {
  const rpcCalls: string[] = []
  const artifactReads: string[] = []
  const owners = opts?.owners ?? { [TARGET]: { owner: OWNER, grants: [] } }
  const machineOwner = opts?.machineOwner ?? OWNER
  const machineGrants = opts?.machineGrants ?? []
  const roots = opts?.roots ?? [ROOT]

  const modules = {
    rpc: {
      readFile: async (input: Record<string, unknown>) => {
        rpcCalls.push(`readFile ${JSON.stringify(input)}`)
        return { ok: true, path: String(input.path), content: 'SECRET BYTES' }
      },
      listDir: async (input: Record<string, unknown>) => {
        rpcCalls.push(`listDir ${JSON.stringify(input)}`)
        return { ok: true, path: ROOT, entries: [{ name: 'secret.ts', isDir: false }] }
      },
      repoOp: async (op: string, cwd: string, _a: unknown, machineId?: MachineId) => {
        rpcCalls.push(`repoOp ${op} ${cwd} ${machineId}`)
        return { ok: true, output: 'secret.ts\0' }
      },
      writeFile: async () => ({ ok: true }),
    },
    issueArtifacts: {
      read: async (issueId: string, artifactId: string, path: string) => {
        artifactReads.push(`${issueId}/${artifactId}/${path}`)
        return { bytes: Buffer.from('SECRET ARTIFACT'), contentType: 'text/plain', size: 15 }
      },
    },
    sessions: {
      sessionOwner: async (sessionId: SessionId) => owners[sessionId],
    },
    issues: {
      has: () => true,
      ancestorIds: () => [],
      // The issue is owned by OWNER. A capability scoped to a DIFFERENT issue,
      // or belonging to another person, is refused by `authorize`'s owned arm.
      ownedTarget: () => ({ kind: 'owned' as const, id: ISSUE, owner: OWNER, grants: [] }),
      issueForCwd: () => null,
    },
    machines: {
      defaultMachine: async () => MACHINE,
      // `id` and `ownerUserId` are the STORE row's spelling, which is what
      // `ownershipSnapshotFromMachines` reads; `machine`/`owner` is the
      // RESOLVED shape it produces. Getting this wrong makes every machine
      // unknown and every refusal pass for the wrong reason — catalogue #14.
      ownershipRows: async () => [{ id: MACHINE, ownerUserId: machineOwner, name: 'alpha' }],
      grantsForMachine: () => machineGrants,
    },
  } as unknown as FileAccessModules

  const repos = { list: async () => roots } as never

  const principalFor = (userId: UserId, capability: Capability): CommandPrincipal =>
    ({ kind: 'user', user: userId, capability }) as unknown as CommandPrincipal

  /** A `FileState` carrying ONLY the gate — which is now the whole of what the
   *  family reaches. There is no `rpc` on this object for a handler to fall
   *  through to, and that is the property PDM-272 bought. */
  const fileStateFor = (userId: UserId, capability = capabilityFor(userId)): FileState => ({
    files: fileAccessGate(modules, repos, { userId, capability }, principalFor(userId, capability)),
  })

  /** The `FamilyState` the SESSION-side read needs, over the SAME owner fixture,
   *  so the two procedures cannot be given two different worlds. */
  const sessionStateFor = (userId: UserId): FamilyState =>
    ({
      caller: { userId, actorSessionId: undefined, sessionState: undefined },
      modules: {
        sessions: { sessionOwner: async (id: SessionId) => owners[id] },
        rpc: {
          readTranscript: async () => {
            rpcCalls.push('readTranscript')
            return { items: [{ text: 'SECRET TRANSCRIPT' }], hasMore: false }
          },
        },
      },
    }) as unknown as FamilyState

  return { fileStateFor, sessionStateFor, rpcCalls, artifactReads }
}

const readFile = (state: FileState, input: Record<string, unknown>) =>
  FILE_QUERIES.read.run(state, input as never)

const codeOf = async (p: Promise<unknown>): Promise<string> => {
  const err = await p.then(() => undefined).catch((e: unknown) => e)
  expect(err).toBeInstanceOf(TRPCError)
  return (err as TRPCError).code
}

describe('files.read — the session-addressed arm', () => {
  it('answers the session owner with the file', async () => {
    const h = harness()
    const r = await readFile(h.fileStateFor(OWNER), { sessionId: TARGET, path: '/wt/a/secret.ts' })
    // The payload really is the sensitive one, which is what stops the refusals
    // below from passing against a version that broke the read for everybody.
    expect(r).toMatchObject({ ok: true, content: 'SECRET BYTES' })
  })

  /** Transitional in exactly the way `queries.status-authz.test.ts` documents:
   *  it pins what `mayReadOwned` answers TODAY (owner-or-grant), and becomes a
   *  REFUSAL when a session's authorization target becomes `private` under
   *  PDM-251. Left positive so that flip is a deliberate, visible edit. */
  it('answers a grantee today — transitional, see PDM-251', async () => {
    const h = harness({ owners: { [TARGET]: { owner: OWNER, grants: [GRANTEE] } } })
    const r = await readFile(h.fileStateFor(GRANTEE), { sessionId: TARGET, path: '/wt/a/x.ts' })
    expect(r).toMatchObject({ ok: true })
  })

  it('refuses a stranger with NOT_FOUND rather than FORBIDDEN', async () => {
    const h = harness()
    // NOT_FOUND, because FORBIDDEN would confirm the session exists.
    expect(
      await codeOf(readFile(h.fileStateFor(STRANGER), { sessionId: TARGET, path: '/wt/a/x.ts' })),
    ).toBe('NOT_FOUND')
  })

  it('reaches no daemon for a stranger: the refusal costs the target nothing', async () => {
    const h = harness()
    await readFile(h.fileStateFor(STRANGER), { sessionId: TARGET, path: '/wt/a/x.ts' }).catch(
      () => undefined,
    )
    // THE ASSERTION THIS FILE EXISTS FOR. The pre-repair handler called
    // `state.rpc.readFile` here and returned the bytes.
    expect(h.rpcCalls).toEqual([])
  })

  it('refuses when the session row has NO owner, rather than reading undefined === undefined', async () => {
    // `sessionOwner` answers undefined for a null owner column. That must be a
    // refusal, not a fallthrough — the hole `mayReadOwned` exists to have closed,
    // and unowned rows are reachable while PDM-276/PDM-273 are open.
    const h = harness({ owners: {} })
    expect(
      await codeOf(readFile(h.fileStateFor(OWNER), { sessionId: TARGET, path: '/wt/a/x.ts' })),
    ).toBe('NOT_FOUND')
    expect(h.rpcCalls).toEqual([])
  })
})

/**
 * THE ASYMMETRY, PINNED AS ONE FACT.
 *
 * These two procedures read the SAME session's bytes over two transports' worth
 * of code, and before PDM-272 one asserted ownership and the other asserted
 * nothing. Asserting them together — same fixture, same stranger, same session —
 * is what stops them drifting apart again: a change that re-opens `files.read`
 * reddens a test whose name says `transcriptRead` refuses too, and the next
 * reader sees immediately that the pair is meant to agree.
 */
describe('the two doors onto one session agree', () => {
  it('refuses the stranger identically through files.read and sessions.transcriptRead', async () => {
    const h = harness()

    const fileCode = await codeOf(
      readFile(h.fileStateFor(STRANGER), { sessionId: TARGET, path: '/wt/a/x.ts' }),
    )
    const transcriptCode = await codeOf(
      SESSION_QUERIES.transcriptRead.run(h.sessionStateFor(STRANGER), {
        sessionId: TARGET,
        direction: 'before',
        limit: 10,
      }),
    )

    expect(fileCode).toBe('NOT_FOUND')
    expect(transcriptCode).toBe('NOT_FOUND')
    // Neither refusal reached the daemon. Before the repair this array held
    // exactly one entry — the file read — and that difference was the finding.
    expect(h.rpcCalls).toEqual([])
  })

  it('serves the owner through both doors', async () => {
    const h = harness()
    const file = await readFile(h.fileStateFor(OWNER), { sessionId: TARGET, path: '/wt/a/x.ts' })
    const transcript = await SESSION_QUERIES.transcriptRead.run(h.sessionStateFor(OWNER), {
      sessionId: TARGET,
      direction: 'before',
      limit: 10,
    })
    expect(file).toMatchObject({ ok: true })
    expect(transcript).toMatchObject({ hasMore: false })
  })
})

describe('files.read — the artifact-addressed arm', () => {
  it('answers a caller whose capability covers the issue', async () => {
    const h = harness()
    const r = await readFile(h.fileStateFor(OWNER), {
      issueId: ISSUE,
      artifactId: 'art_1',
      path: 'shot.png',
    })
    expect(r).toMatchObject({ ok: true, content: 'SECRET ARTIFACT' })
  })

  it('refuses an issue the capability does not cover, and reads no artifact', async () => {
    const h = harness()
    // The stranger's own capability: same role, scoped to what THEY own. The
    // issue belongs to OWNER, so `authorize`'s owned arm refuses. The pre-repair
    // arm ignored the capability entirely and served any issue id named.
    const err = await readFile(h.fileStateFor(STRANGER), {
      issueId: ISSUE,
      artifactId: 'art_1',
      path: 'shot.png',
    })
      .then(() => undefined)
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TRPCError)
    // THE ASSERTION THIS CASE EXISTS FOR: the store was never touched.
    expect(h.artifactReads).toEqual([])
  })
})

describe('files.read / list / search — the root-addressed arms', () => {
  it('refuses a root that is not a registered repository, as it always did', async () => {
    // `assertAllowedRoot` is KEPT, not replaced. Containment is not
    // authorization, but it is still containment.
    const h = harness()
    expect(
      await codeOf(readFile(h.fileStateFor(OWNER), { root: '/etc', path: '/etc/shadow' })),
    ).toBe('FORBIDDEN')
    expect(h.rpcCalls).toEqual([])
  })

  it('answers a caller who may use the machine the root lives on', async () => {
    const h = harness()
    const r = await readFile(h.fileStateFor(OWNER), { root: ROOT, path: `${ROOT}/secret.ts` })
    expect(r).toMatchObject({ ok: true, content: 'SECRET BYTES' })
  })

  it('refuses a caller who cannot see that machine, and reaches no daemon', async () => {
    // The root IS allowlisted. Containment says yes; the owned-compute boundary
    // says no. Before the repair only the first question was asked, so this case
    // returned the bytes.
    //
    // NOT_FOUND RATHER THAN FORBIDDEN, and that is `checkMachineVerb`'s rule
    // rather than a choice made here: a principal who cannot SEE a machine is
    // told it does not exist, in the same words a never-paired id gets, so the
    // surface is not an existence oracle over someone else's fleet. The next
    // case is the other half of that split.
    const h = harness({ machineOwner: OWNER })
    expect(
      await codeOf(readFile(h.fileStateFor(STRANGER), { root: ROOT, path: `${ROOT}/secret.ts` })),
    ).toBe('NOT_FOUND')
    expect(h.rpcCalls).toEqual([])
  })

  it('refuses with FORBIDDEN a caller who may SEE the machine but not USE it', async () => {
    // The other half of the split above, and the reason this file cannot claim
    // "the machine check runs" from the NOT_FOUND case alone: a gate that
    // refused everyone would also produce that. Here the stranger holds a real
    // `see` grant, so absence is not the answer and the verb decides.
    const h = harness({
      machineOwner: OWNER,
      machineGrants: [{ grantee: STRANGER, verb: 'see' }],
    })
    expect(
      await codeOf(readFile(h.fileStateFor(STRANGER), { root: ROOT, path: `${ROOT}/secret.ts` })),
    ).toBe('FORBIDDEN')
    expect(h.rpcCalls).toEqual([])
  })

  it('refuses the directory walk for a caller who may not use the machine', async () => {
    const h = harness({ machineOwner: OWNER })
    expect(
      await codeOf(FILE_QUERIES.list.run(h.fileStateFor(STRANGER), { root: ROOT } as never)),
    ).toBe('NOT_FOUND')
    expect(h.rpcCalls).toEqual([])
  })

  it('refuses the content search for a caller who may not use the machine', async () => {
    const h = harness({ machineOwner: OWNER })
    expect(
      await codeOf(
        FILE_QUERIES.search.run(h.fileStateFor(STRANGER), {
          root: ROOT,
          query: 'secret',
          limit: 5,
        } as never),
      ),
    ).toBe('NOT_FOUND')
    // `git ls-files` never ran on a machine this caller does not hold.
    expect(h.rpcCalls).toEqual([])
  })

  it('dispatches to the machine it authorized, not to whichever the broker picks', async () => {
    // Resolve-once. The gate resolves an omitted machineId and passes the
    // resolved id on, so the machine checked and the machine read are one.
    const h = harness()
    await readFile(h.fileStateFor(OWNER), { root: ROOT, path: `${ROOT}/x.ts` })
    expect(h.rpcCalls[0]).toContain(MACHINE)
  })
})
