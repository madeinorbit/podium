/**
 * THE ISSUE CLI / MCP SURFACE, DRIVEN AGAINST A RUNNING SERVER OBJECT.
 *
 * The runtime half of the pair whose source half is `scripts/audit-issue-commands.ts`.
 * Its whole reason for existing is the failure class that dominated this run: POD-732
 * found the workflow CLI suite driving a `Proxy` that answers every procedure, so it
 * "would stay green against a server serving nothing". THERE IS NO PROXY AND NO MOCK
 * HERE. `new SessionRegistry()` builds the real `IssueCommandDispatcher` over the real
 * `IssueService`, and `asIssueTrpc` is the same object the in-process MCP tools call.
 *
 * ## What is executed for real, and what deliberately is not
 *
 * Every read verb below RUNS: real client, real guard, real zod parse, real service,
 * real rows created by a real `create`. So does a representative write path
 * (`create → comment → label → close`), which is the one that proves the mutation
 * arm is wired and not merely present.
 *
 * NOT executed: `start`, `add-session`, `add-shell`, `action`, `cleanup`, `stop`,
 * `integrate`. Those spawn agent sessions, run git, or touch worktrees — driving them
 * from a unit lane would spawn real processes on this machine. For those the check is
 * reachability against the real dispatcher object plus the source-half audit, and
 * saying so here is the point: a suite that quietly skipped them would be claiming
 * coverage it does not have.
 *
 * ## Why reachability against the real object is worth anything
 *
 * Because the object is DERIVED. `asIssueTrpc` builds its `issues` record from
 * `ISSUE_COMMAND_NAMES`, which is now `Object.keys(ISSUE_CONTRACTS)` — so a contract
 * that disappears really does take its procedure with it, and the absence assertions
 * below can fail. That is proven, not assumed: the first test asks the real object for
 * a procedure that does not exist and requires it to be missing.
 */

import { ISSUE_COMMAND_NAMES, ISSUE_CONTRACTS } from '@podium/commands'
import { ISSUE_COMMANDS } from '@podium/issue-client'
import { afterAll, describe, expect, it } from 'vitest'

import { SessionRegistry } from '../../relay'
import { OPERATOR } from '../../test-support/capabilities'

const registries: SessionRegistry[] = []
const fresh = (): SessionRegistry => {
  const r = new SessionRegistry(undefined, undefined, { instanceId: 'default' })
  registries.push(r)
  return r
}
afterAll(() => {
  for (const r of registries.splice(0)) r.dispose()
})

/**
 * Parse argv-shaped args through the verb's OWN schema, exactly as `apps/cli` does
 * before calling `run`. Skipping this step is how a suite ends up testing a call
 * convention the product never uses — the CLI's schemas coerce (`idArg` accepts a
 * number) and default (`comment.author` defaults to 'agent'), and a body that gets
 * raw args sees neither.
 */
const parseArgs = (
  cmd: { args: { parse: (v: unknown) => unknown } } | undefined,
  args: Record<string, unknown>,
): Record<string, unknown> => cmd?.args.parse(args) as Record<string, unknown>

/** Contracts that say they are on the CLI and the MCP tool surface. */
const CLI_EXPOSED = ISSUE_COMMAND_NAMES.filter((n) => ISSUE_CONTRACTS[n].exposure.includes('cli'))

describe('the real in-process client serves every cli/mcp-exposed contract', () => {
  it('the instrument can say NO: the real object refuses a procedure that has no contract', () => {
    const client = fresh().issueCommands.asIssueTrpc(OPERATOR)
    const issues = client.issues as unknown as Record<string, unknown>
    // Derived from the contract table, so a name with no contract is genuinely absent.
    expect(issues.thisCommandHasNoContract).toBeUndefined()
    expect(Object.keys(issues).sort()).toEqual([...ISSUE_COMMAND_NAMES].sort())
    // And the specs/lock routers really are NOT served in-process — the historical
    // behaviour, asserted so "everything is reachable" cannot be read into this file.
    expect(() => (client.specs as { list: { query: () => unknown } }).list.query()).toThrow(
      /no such issue procedure/,
    )
  })

  it('every cli/mcp-exposed contract has a live procedure on the real client', () => {
    const client = fresh().issueCommands.asIssueTrpc(OPERATOR)
    const issues = client.issues as unknown as Record<string, { query: unknown; mutate: unknown }>
    expect(CLI_EXPOSED).toHaveLength(61)
    for (const name of CLI_EXPOSED) {
      expect(typeof issues[name]?.query, name).toBe('function')
      expect(typeof issues[name]?.mutate, name).toBe('function')
    }
  })
})

describe('the podium issue CLI table renders over the real surface', () => {
  /** The verbs whose bodies spawn processes, run git, or touch worktrees. Named,
   *  not silently skipped — see the header. */
  const SIDE_EFFECTING = new Set([
    'start',
    'add-session',
    'add-shell',
    'action',
    'cleanup',
    'stop',
    'delete',
    'restore',
  ])

  it('every CLI verb names a real command and a summary the help screen can print', () => {
    expect(ISSUE_COMMANDS.length).toBeGreaterThan(50)
    for (const cmd of ISSUE_COMMANDS) {
      expect(cmd.name, cmd.name).toMatch(/^[a-z][a-z-]*$/)
      expect(cmd.summary.trim().length, cmd.name).toBeGreaterThan(0)
      expect(typeof cmd.run, cmd.name).toBe('function')
    }
  })

  it('READ verbs execute end to end against the real registry and return real data', async () => {
    const reg = fresh()
    const client = reg.issueCommands.asIssueTrpc(OPERATOR)
    const made = reg.issues.create({ repoPath: '/r', title: 'Runtime probe', startNow: false })

    // Pure reads only. `doctor`, `preflight`, `lint` and `orphans` shell out to git
    // and the filesystem; running them from a unit lane would be measuring this
    // machine, not the surface. They are covered by the reachability check above and
    // by the source-half audit, and are named here rather than quietly omitted.
    const readVerbs = ['list', 'ready', 'blocked', 'stats', 'count', 'prime']
    let ran = 0
    for (const name of readVerbs) {
      const cmd = ISSUE_COMMANDS.find((c) => c.name === name)
      expect(cmd, `${name}: no such CLI verb`).toBeDefined()
      const result = await cmd?.run(client, parseArgs(cmd, { repoPath: '/r' }))
      expect(typeof result?.text, name).toBe('string')
      ran += 1
    }
    expect(ran).toBe(readVerbs.length)

    // `show` reaches the issue that was really created — the assertion that
    // distinguishes "the call returned" from "the call returned the right row".
    const show = ISSUE_COMMANDS.find((c) => c.name === 'show')
    const shown = await show?.run(client, parseArgs(show, { id: String(made.seq) }))
    expect(shown?.text).toContain('Runtime probe')
  })

  it('a WRITE path executes end to end: create → comment → label → close', async () => {
    const reg = fresh()
    const client = reg.issueCommands.asIssueTrpc(OPERATOR)
    const verb = (name: string) => {
      const c = ISSUE_COMMANDS.find((x) => x.name === name)
      expect(c, `${name}: no such CLI verb`).toBeDefined()
      return c
    }

    const createCmd = verb('create')
    await createCmd?.run(
      client,
      parseArgs(createCmd, { repoPath: '/r', title: 'Written by the CLI table' }),
    )
    const created = reg.issues.list('/r').find((i) => i.title === 'Written by the CLI table')
    expect(created, 'the CLI create really wrote a row').toBeDefined()
    const id = String(created?.seq)

    const commentCmd = verb('comment')
    await commentCmd?.run(client, parseArgs(commentCmd, { id, body: 'a real comment' }))
    expect(reg.issues.comments(created?.id as string).map((c) => c.body)).toContain(
      'a real comment',
    )

    const labelCmd = verb('label')
    const labelled = await labelCmd?.run(client, parseArgs(labelCmd, { id, labels: 'alpha,beta' }))
    // The surface's own answer, and the row it wrote — both, because a rendering that
    // echoes its input would satisfy the first assertion alone.
    expect(labelled?.text).toContain('alpha, beta')
    expect((reg.issues.get(created?.id as string) as { labels?: string[] })?.labels).toEqual([
      'alpha',
      'beta',
    ])

    const closeCmd = verb('close')
    await closeCmd?.run(client, parseArgs(closeCmd, { id }))
    expect(reg.issues.getMeta(created?.id as string)?.stage).toBe('done')
  })

  it('the side-effecting verbs are reachable, and are listed rather than silently skipped', () => {
    const client = fresh().issueCommands.asIssueTrpc(OPERATOR)
    const issues = client.issues as unknown as Record<string, unknown>
    for (const name of SIDE_EFFECTING) {
      expect(
        ISSUE_COMMANDS.some((c) => c.name === name),
        `${name}: gone from the CLI table`,
      ).toBe(true)
    }
    // Their procs are live on the real client even though this lane does not fire them.
    for (const proc of [
      'start',
      'addSession',
      'addShell',
      'action',
      'cleanup',
      'stop',
      'integrate',
    ]) {
      expect(issues[proc], proc).toBeDefined()
    }
  })
})
