/**
 * ARTIFACT-ADD PULLS BYTES OFF A MACHINE, SO IT MUST ASK FIRST — PDM-135.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THIS FILE MEASURES
 * ---------------------------------------------------------------------------
 *
 * `IssueArtifactStore` used to be constructed at server boot with a bare
 * `{readAsset, listDir}` adapter over the daemon RPC — one unauthorized handle,
 * held for the life of the process, shared by every caller. `artifact-add`'s
 * only authorization was `issues.panelApply`'s contract: `action: 'write'`,
 * `roleFloor: 'member'`, `resource: 'issue'`. That answers *may you edit this
 * task*. It has never answered *may you read files on the machine this task's
 * worktree is on*, and the two stop being the same question the moment a task
 * has a second member.
 *
 * The path containment in `panelArtifactAdd` is not a substitute: it confines
 * the source to the issue's own worktree, and being confined to somebody else's
 * checkout is not a refusal. So a member who could write the issue could name
 * any relative path under the owner's worktree — `.env`, a credential file,
 * private notes — have the server pull it into the artifact store, and then read
 * it back through `GET /files/artifact/…`, which authorizes correctly and by
 * then is serving a task artifact that genuinely belongs to the task.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS ASSERTED, AND WHY IT IS ASSERTED THIS WAY
 * ---------------------------------------------------------------------------
 *
 * THE DECISION IS NOT MOCKED. Catalogue shape 20: a test that stubs the
 * permission call pins the call order and would pass with the real rule deleted.
 * So this file builds the REAL `fileAccessGate` over a real
 * `ownershipSnapshotFromMachines`, and the refusal comes from `checkMachineUse`
 * itself. The only fakes are the daemon (which records what it was asked for)
 * and the stores the gate reads rows from.
 *
 * THE OBSERVATION IS THE DAEMON, NOT THE THROW. A route that read the bytes and
 * threw on the way out would satisfy `rejects.toThrow` while having disclosed
 * everything. `daemonTouches` is the real assertion: a refused add must leave it
 * EMPTY, which is what "source authorization precedes copy" has to mean.
 *
 * BOTH HALVES ARE `expect.soft`. A hard assert on the positive would hide the
 * negative behind it, and the negative is the half that carries the finding.
 *
 * AND THE LAST TEST IS THE ONE THAT MATTERS MOST. The repair's whole claim is
 * that artifact-add and `files.read` now run ONE rule, because the store holds a
 * `Pick` of the same gate rather than a twin of it. A rule can stop binding one
 * door while every per-door test stays green, so the claim is asserted directly:
 * the SAME gate instance refuses the SAME stranger through both doors. Breaking
 * `requireRoot` reddens both families — see this issue's receipt for the
 * deliberate break and what each door reported.
 */

import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asIssueId, asMachineId, asUserId, type MachineId, type UserId } from '@podium/model'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { userCommandPrincipal } from '../../command-principal'
import { type FileAccessModules, fileAccessGate } from '../files/file-access-gate'
import { IssueArtifactStore } from './artifact-store'

const OWNER = asUserId('user_owner')
/** A second ACTIVE MEMBER. Not an intruder — this is the person C4 hands every
 *  task to, which is why the single-user reading of this file is the wrong one. */
const STRANGER = asUserId('user_stranger')
const MACHINE: MachineId = asMachineId('m_owner_laptop')
const ISSUE = asIssueId('iss_1')
const WORKTREE = '/repo/.worktrees/issue-1'
const SECRET = 'AWS_SECRET_ACCESS_KEY=totally-real'

function harness() {
  /** Every path the daemon was asked for, in order. A refused pull must add
   *  NOTHING here — that is what this file exists to assert. */
  const daemonTouches: string[] = []

  const modules = {
    rpc: {
      readAsset: async (input: { path: string }) => {
        daemonTouches.push(`readAsset:${input.path}`)
        return {
          ok: true,
          path: input.path,
          dataBase64: Buffer.from(SECRET).toString('base64'),
          size: SECRET.length,
        }
      },
      listDir: async (input: { path?: string; root: string }) => {
        const at = input.path ?? input.root
        daemonTouches.push(`listDir:${at}`)
        // Not a directory: the snapshotter falls through to the plain-file plan.
        return { ok: false, path: at, entries: [], error: 'not a directory' }
      },
      readFile: async (input: { path: string }) => {
        daemonTouches.push(`readFile:${input.path}`)
        return { ok: true, content: SECRET }
      },
      repoOp: async () => ({ ok: true }),
      writeFile: async () => ({ ok: true }),
    },
    issueArtifacts: { read: async () => null },
    sessions: { sessionOwner: async () => undefined },
    issues: {
      has: () => true,
      ancestorIds: () => [],
      ownedTarget: () => ({ kind: 'owned' as const, id: ISSUE, owner: OWNER, grants: [] }),
      issueForCwd: () => null,
    },
    machines: {
      defaultMachine: async () => MACHINE,
      // THE ROW THAT DECIDES IT: the machine belongs to OWNER, and nobody has
      // been granted a verb on it. `machineVerbsFor` gives STRANGER no `see`,
      // so the refusal is NOT_FOUND rather than FORBIDDEN — the gate must not
      // become an existence oracle over another member's fleet.
      ownershipRows: async () => [{ id: MACHINE, ownerUserId: OWNER }],
      grantsForMachine: () => [],
    },
  } as unknown as FileAccessModules

  /** The issue worktree sits under a registered repo root, which is the real
   *  arrangement — `root-allowlist.test.ts` pins that nesting explicitly. So
   *  containment PASSES for both callers and the machine rule is what decides,
   *  rather than the allowlist deciding it for the wrong reason. */
  const repos = { list: async () => ['/repo'] } as never

  const gateFor = (userId: UserId) =>
    fileAccessGate(
      modules,
      repos,
      { userId, capability: userCommandPrincipal(userId, 'member').capability },
      userCommandPrincipal(userId, 'member'),
    )

  return { daemonTouches, gateFor }
}

describe('artifact-add source authorization [PDM-135]', () => {
  let base: string
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'podium-artifact-authz-'))
  })
  afterEach(() => rmSync(base, { recursive: true, force: true }))

  it('pulls for the member who may use the machine the worktree is on', async () => {
    // The positive. Without it every refusal below would also pass against a
    // store that had simply stopped working.
    const { daemonTouches, gateFor } = harness()
    const store = new IssueArtifactStore(base)

    const snap = await store.snapshot({
      issueId: ISSUE,
      root: WORKTREE,
      machineId: MACHINE,
      sourcePath: 'shots/a.png',
      source: gateFor(OWNER),
    })

    expect.soft(snap.files).toEqual([{ path: 'a.png', size: SECRET.length }])
    expect.soft(daemonTouches).toContain(`readAsset:${WORKTREE}/shots/a.png`)
    expect
      .soft((await store.read(ISSUE, snap.artifactId, 'a.png'))?.bytes.toString())
      .toBe(SECRET)
  })

  it('refuses a second member who may edit the task but not use its machine, before any byte moves', async () => {
    const { daemonTouches, gateFor } = harness()
    const store = new IssueArtifactStore(base)

    await expect
      .soft(
        store.snapshot({
          issueId: ISSUE,
          root: WORKTREE,
          machineId: MACHINE,
          // The path is INSIDE the issue worktree, so containment admits it.
          // Containment to somebody else's checkout is not a refusal.
          sourcePath: '.env',
          source: gateFor(STRANGER),
        }),
      )
      .rejects.toThrow()

    // THE ASSERTION THIS FILE IS FOR. Not "it threw" — "it never asked".
    expect.soft(daemonTouches).toEqual([])
    expect.soft(existsSync(join(base, ISSUE))).toBe(false)
  })

  it('refuses that member identically through files.read — one rule, both doors', async () => {
    // The store holds a `Pick` of the gate, not a twin of it, so `requireRoot`
    // is literally the same function on both paths. Asserted rather than argued:
    // if a future edit gives artifact-add its own predicate, the two answers
    // here come apart while every per-door test above stays green.
    const { daemonTouches, gateFor } = harness()
    const store = new IssueArtifactStore(base)
    const stranger = gateFor(STRANGER)

    await expect
      .soft(
        store.snapshot({
          issueId: ISSUE,
          root: WORKTREE,
          machineId: MACHINE,
          sourcePath: '.env',
          source: stranger,
        }),
      )
      .rejects.toThrow()
    await expect.soft(stranger.readRoot(WORKTREE, '.env', MACHINE)).rejects.toThrow()
    expect.soft(daemonTouches).toEqual([])

    // And the owner is served through BOTH, so the pair above is a statement
    // about the CALLER and not about the root or the machine being unreachable.
    const owner = gateFor(OWNER)
    await expect.soft(owner.readRoot(WORKTREE, '.env', MACHINE)).resolves.toMatchObject({ ok: true })
    await expect
      .soft(
        store.snapshot({
          issueId: ISSUE,
          root: WORKTREE,
          machineId: MACHINE,
          sourcePath: '.env',
          source: owner,
        }),
      )
      .resolves.toMatchObject({ entry: '.env' })
  })
})
