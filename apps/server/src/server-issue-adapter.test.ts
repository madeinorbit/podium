import { afterEach, describe, expect, it } from 'vitest'

import { onBehalfOfUser } from './command-principal'
import { fileAccessGate } from './modules/files/file-access-gate'
import { SessionRegistry } from './relay'
import { RepoRegistry } from './repo-registry'
import { OPERATOR } from './test-support/capabilities'

// The in-process MCP reaches the tracker through the command registry's derived
// IssueTrpc client (IssueCommandDispatcher.asIssueTrpc — the typed replacement for
// the old callerAsIssueTrpc Proxy over appRouter.createCaller). This proves the
// derived client forwards both mutate and query — i.e. the superagent's issue
// tools work without the cookie-gated HTTP loopback (which would 401).
const registries: SessionRegistry[] = []
afterEach(async () => {
  for (const r of registries.splice(0)) await r.dispose()
})

async function client() {
  const registry = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
  registries.push(registry)
  /**
   * THE FILE GATE IS THE COMPOSITION ROOT'S, AND THIS FIXTURE IS ONE (PDM-135).
   *
   * `artifact-add` pulls bytes off a machine, so it reads through a per-caller
   * `ArtifactSourceGate` that needs a `RepoRegistry` — built OVER the relay, so
   * the relay cannot build its own. Until `installFileGate` runs, the relay
   * refuses every artifact source read, deliberately: "ABSENT DENIES", because
   * the alternative is a default that reads without asking.
   *
   * `server.ts` installs it at boot, so production always has one. A bare
   * `SessionRegistry.create` does not, and `registry.ts` binds `source:
   * ctx.fileGate` when it builds the op's options — BEFORE `panelArtifactAdd`
   * runs any of its own checks. So the refusal below arrived in place of the
   * worktree one this test is about, and the fail-closed relay was answering for
   * a read that never happens for a worktree-less issue.
   *
   * Installing the REAL gate here, the way the root does, is what keeps the
   * assertion about what it says it is about. A stub would have done the same
   * job for this one case and quietly stopped being a gate.
   */
  const repos = new RepoRegistry(registry, registry.sessionStore)
  registry.installFileGate((caller) => {
    const principal = caller.principal
    if (principal === undefined) throw new Error('fixture caller carries no principal')
    const userId = onBehalfOfUser(principal)
    if (userId === null) throw new Error('fixture caller holds no capability to read files with')
    return fileAccessGate(
      registry.modules,
      repos,
      {
        userId,
        capability: caller.capability,
        ...(caller.overrideScope ? { overrideScope: true } : {}),
      },
      principal,
    )
  })
  return registry.issueCommands.asIssueTrpc(OPERATOR)
}

describe('IssueCommandDispatcher.asIssueTrpc (in-process MCP client)', () => {
  it('forwards a mutation (.mutate) through the registry pipeline', async () => {
    const c = await client()
    const created = (await c.issues.create.mutate({
      repoPath: '/r',
      title: 'via adapter',
      startNow: false,
    })) as { seq: number; title: string }
    expect(created.seq).toBe(1)
    expect(created.title).toBe('via adapter')
  })

  it('forwards a query (.query) through the registry pipeline', async () => {
    const c = await client()
    await c.issues.create.mutate({ repoPath: '/r', title: 'q', startNow: false })
    const list = await c.issues.list.query({ repoPath: '/r' })
    expect(list).toHaveLength(1)
  })

  it('panelApply artifact-add pulls a snapshot — errors cleanly with no owning worktree ([spec:SP-0fc9])', async () => {
    const c = await client()
    const created = (await c.issues.create.mutate({
      repoPath: '/r',
      title: 'a',
      startNow: false,
    })) as { id: string }
    await expect(
      Promise.resolve(
        c.issues.panelApply.mutate({ id: created.id, op: 'artifact-add', path: 'shot.png' }),
      ),
    ).rejects.toThrow(/no owning worktree/)
    // nothing half-registered
    const got = (await c.issues.get.query({ id: created.id })) as {
      panel?: { artifacts: unknown[] }
    }
    expect(got.panel?.artifacts ?? []).toEqual([])
  })

  it('an unknown router/proc throws the historical "no such issue procedure"', async () => {
    const c = await client()
    expect(() => c.specs.list.query({})).toThrow(/no such issue procedure: specs\.list/)
  })
})
