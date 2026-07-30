/**
 * THE SPEC CLI / MCP SURFACE, DRIVEN AGAINST REAL OBJECTS.
 *
 * POD-385's exposure claim is that `specs.create · specs.save · specs.remove` are
 * served on `trpc`, `relay` and `cli`, and on NOTHING else — in particular not on
 * `mcp`, because POD-311's finding that the issue CLI and MCP are one table does
 * not transfer to this family. A claim like that is worth exactly what checks it,
 * so it is checked here in BOTH directions, as POD-311 did: a proc the CLI reaches
 * without the tag, and a tag with nothing reaching it, are both findings.
 *
 * ## There is no Proxy here, and that is deliberate
 *
 * POD-732 found the workflow CLI suite driving a `Proxy` that answers every
 * procedure — "green against a server serving nothing". The client below is built
 * by mapping over `specsInputs`, the REAL schema table the tRPC slice and the relay
 * both mount, and every call goes through `SpecsService.invoke`: real zod parse,
 * real repo-root gate, real file store, real temp repo on disk. A proc with no
 * entry in that table is genuinely absent from the client, and the first test asks
 * for one and requires it to be missing — so the reach assertions can fail.
 *
 * What the recorder adds is only WHICH proc a CLI verb addressed. That is the one
 * fact no amount of end-to-end execution reveals on its own, and it is separate
 * from whether the service serves it, which `SpecsService.has` answers.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SPEC_CONTRACT_NAMES, SPEC_CONTRACTS } from '@podium/commands'
import type { IssueTrpc } from '@podium/issue-client'
import { ISSUE_COMMANDS, SPEC_COMMANDS } from '@podium/issue-client'
import { afterEach, describe, expect, it } from 'vitest'
import { IssueToolProvider } from '../../issue-mcp'
import { SpecsService, specsInputs } from './service'

let dirs: string[] = []
function tmpRepo(): string {
  const d = mkdtempSync(join(tmpdir(), 'podium-spec-surface-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
})

/**
 * A client over the REAL service, derived from the REAL schema table. Records the
 * procs a CLI verb addresses; executes them for real. See the header for why this
 * is not the `Proxy` POD-732 removed.
 */
function realClient(svc: SpecsService, calls: string[]): IssueTrpc {
  const call = (proc: string) => (input: unknown) => {
    calls.push(proc)
    return svc.invoke(proc, input) as Promise<unknown>
  }
  const specs = Object.fromEntries(
    Object.keys(specsInputs).map((proc) => [proc, { query: call(proc), mutate: call(proc) }]),
  )
  return { specs } as unknown as IssueTrpc
}

/** The CLI verb → the proc(s) it addresses. `update` is the one whose names differ:
 *  the CLI calls it `update` and the wire calls it `save`. */
const drive = async (
  verb: string,
  args: Record<string, unknown>,
): Promise<{ calls: string[]; text: string }> => {
  const repo = tmpRepo()
  const svc = new SpecsService({ repoRoots: () => [repo] })
  const calls: string[] = []
  const cmd = SPEC_COMMANDS.find((c) => c.name === verb)
  if (!cmd) throw new Error(`no such spec CLI verb: ${verb}`)
  // Seed a real component for the verbs that need a target.
  const seeded = svc.create({ repoPath: repo, title: 'Seeded', parent: 'SP-root' })
  const parsed = cmd.args.parse({
    repoPath: repo,
    ...args,
    ...(args.id === '@seeded' ? { id: seeded.id } : {}),
  })
  const result = await cmd.run(realClient(svc, calls), parsed as Record<string, unknown>)
  return { calls, text: result.text }
}

describe('the instrument can say NO', () => {
  it('the client is derived from the real schema table, so an absent proc is absent', () => {
    const repo = tmpRepo()
    const svc = new SpecsService({ repoRoots: () => [repo] })
    const client = realClient(svc, []) as unknown as { specs: Record<string, unknown> }
    expect(client.specs.thisProcHasNoSchema).toBeUndefined()
    expect(Object.keys(client.specs).sort()).toEqual(
      ['create', 'get', 'list', 'remove', 'save', 'search'].sort(),
    )
    // …and the service itself refuses it, which is what makes the reach checks
    // below about the SERVER rather than about this file's own object.
    expect(svc.has('thisProcHasNoSchema')).toBe(false)
    expect(svc.has('create')).toBe(true)
    expect(svc.invoke('thisProcHasNoSchema', {})).toBeUndefined()
  })
})

describe('declared `cli` exposure equals what the CLI actually reaches', () => {
  /** The contracts that SAY they are on the CLI. */
  const CLI_EXPOSED = SPEC_CONTRACT_NAMES.filter((n) => SPEC_CONTRACTS[n].exposure.includes('cli'))

  it('every write contract naming `cli` is reached by a real CLI verb, executing for real', async () => {
    expect(CLI_EXPOSED).toEqual(['create', 'remove', 'save'])

    const created = await drive('create', { parent: 'SP-root', title: 'Retry rules' })
    expect(created.calls).toEqual(['create'])
    expect(created.text).toMatch(/^created SP-/)

    // `--body` makes the CLI's `create` a two-proc verb — it creates, then saves.
    // Asserted rather than glossed: it is the one place a CLI verb reaches a
    // contract other than its namesake.
    const withBody = await drive('create', {
      parent: 'SP-root',
      title: 'Retry rules',
      body: '<p>at most twice</p>',
    })
    expect(withBody.calls).toEqual(['create', 'save'])

    const updated = await drive('update', { id: '@seeded', title: 'Renamed' })
    expect(updated.calls).toEqual(['save'])
    expect(updated.text).toContain('Renamed')

    const removed = await drive('remove', { id: '@seeded' })
    expect(removed.calls).toEqual(['remove'])

    // BOTH DIRECTIONS. The union of procs the CLI's write verbs address is exactly
    // the set of contracts declaring `cli` — neither a proc reached without a tag
    // nor a tag with nothing reaching it.
    const reached = new Set([
      ...created.calls,
      ...withBody.calls,
      ...updated.calls,
      ...removed.calls,
    ])
    expect([...reached].sort()).toEqual([...CLI_EXPOSED].sort())
  })

  it('the read verbs reach only procs that have NO contract — the split POD-385 declared', async () => {
    // list/get/search are deliberately outside the contract table. If a future
    // issue contracts them, this fails and the exposure claim gets revisited
    // rather than drifting.
    const tree = await drive('tree', {})
    const shown = await drive('show', { id: '@seeded' })
    const found = await drive('search', { query: 'Seeded' })
    const readProcs = new Set([...tree.calls, ...shown.calls, ...found.calls])
    expect([...readProcs].sort()).toEqual(['get', 'list', 'search'])
    for (const proc of readProcs) {
      expect([proc, (SPEC_CONTRACT_NAMES as string[]).includes(proc)]).toEqual([proc, false])
      // …but the SERVICE serves them, so "no contract" is a scope statement and
      // not a claim that the read surface does not exist.
      expect([proc, new SpecsService({ repoRoots: () => [] }).has(proc)]).toEqual([proc, true])
    }
  })
})

describe('there is no MCP spec tool, and the contracts say so', () => {
  it('no contract names `mcp`, and no MCP tool reaches a spec proc', () => {
    for (const name of SPEC_CONTRACT_NAMES) {
      expect([name, SPEC_CONTRACTS[name].exposure.includes('mcp')]).toEqual([name, false])
    }

    // The RUNNING object, not a grep. `IssueToolProvider` is what `server.ts`
    // hands to the MCP route, composed into the `podium` surface.
    const tools = new IssueToolProvider().mcpToolSpecs()
    const specTools = tools.filter(
      (t) => t.name.startsWith('spec') || t.name.includes('_spec_') || t.name.endsWith('_spec'),
    )
    expect(specTools.map((t) => t.name)).toEqual([])

    // THE PROBE THAT MAKES THE EMPTY LIST MEAN SOMETHING. A provider that
    // advertised nothing at all would satisfy the assertion above perfectly —
    // POD-732's "an empty router satisfies every absence claim". It is not empty:
    // it advertises the issue tools, which is exactly the collapse POD-311 found
    // and this family does not have.
    expect(tools.length).toBeGreaterThan(50)
    expect(tools.every((t) => t.name.startsWith('issue_'))).toBe(true)
    expect(tools.some((t) => t.name === 'issue_create')).toBe(true)
  })

  it('the MCP surface derives from the ISSUE table alone, so the spec table adds nothing', () => {
    /**
     * THE CHECK THAT ACTUALLY DECIDES, rather than the one that first suggested
     * itself. Comparing tool names against spec verb names is a NAME-COINCIDENCE
     * test and it is wrong in both directions: `issue_prime` exists and is the
     * ISSUE prime, which has nothing to do with `podium spec prime` — that
     * collision alone made the naive check fail while the underlying claim held.
     *
     * Derivation is the real question, and it is answerable exactly: the provider
     * advertises one tool per `ISSUE_COMMANDS` entry and no more. A surface that
     * had grown a spec arm would carry more tools than that table has rows.
     */
    const tools = new IssueToolProvider().mcpToolSpecs().map((t) => t.name)
    const fromIssueTable = ISSUE_COMMANDS.map((c) => `issue_${c.name.replace(/-/g, '_')}`)
    expect(tools.sort()).toEqual([...fromIssueTable].sort())
    expect(tools).toHaveLength(ISSUE_COMMANDS.length)
    // And the spec table is a genuinely different, non-empty object — so "adds
    // nothing" is a fact about the wiring, not about an empty table.
    expect(SPEC_COMMANDS.length).toBeGreaterThan(0)
    expect(SPEC_COMMANDS.map((c) => c.name)).toContain('create')
  })
})

describe('the contract schemas are THE schemas the surface validates with', () => {
  /**
   * IDENTITY, NOT EQUALITY, and the distinction is the whole test (POD-305).
   *
   * A schema restated in `service.ts` with the same fields is byte-identical on the
   * wire and passes every golden fixture; only `toBe` sees the fork. These three
   * assertions are what make "one definition site" a checkable claim rather than a
   * comment — the tRPC slice mounts `specsInputs`, the relay parses with
   * `specsInputs`, and `specsInputs` IS the contract table's schema set.
   */
  it('mounts the contract instance for each of the three writes', () => {
    expect(specsInputs.create).toBe(SPEC_CONTRACTS.create.input)
    expect(specsInputs.save).toBe(SPEC_CONTRACTS.save.input)
    expect(specsInputs.remove).toBe(SPEC_CONTRACTS.remove.input)
  })

  it('the identity assertion above can fail — the reads are NOT contract instances', () => {
    // The counterfactual. `toBe` against a same-shaped schema is exactly the
    // comparison that would pass if `toBe` behaved like `toEqual`, so the read
    // schemas — which really are locally declared — are shown NOT matching any
    // contract input.
    const contractInputs = SPEC_CONTRACT_NAMES.map((n) => SPEC_CONTRACTS[n].input as unknown)
    expect(contractInputs).not.toContain(specsInputs.list as unknown)
    expect(contractInputs).not.toContain(specsInputs.get as unknown)
    expect(contractInputs).not.toContain(specsInputs.search as unknown)
    expect(contractInputs).toContain(specsInputs.save as unknown)
  })

  it('validates identically to what shipped — the AC is behaviour UNCHANGED', async () => {
    const repo = tmpRepo()
    const svc = new SpecsService({ repoRoots: () => [repo] })
    // The refusals the shipped schemas made, still made, through the relay path.
    await expect(svc.invoke('create', { repoPath: repo, parent: 'SP-root' })).rejects.toThrow()
    await expect(
      svc.invoke('create', { repoPath: repo, title: '', parent: 'SP-root' }),
    ).rejects.toThrow()
    await expect(svc.invoke('save', { repoPath: repo, id: '' })).rejects.toThrow()
    await expect(svc.invoke('remove', { repoPath: '', id: 'SP-abcd' })).rejects.toThrow()
    // …and the acceptances, so the refusals are not a schema that rejects everything.
    const made = (await svc.invoke('create', {
      repoPath: repo,
      title: 'Accepted',
      parent: 'SP-root',
    })) as { id: string }
    expect(made.id).toMatch(/^SP-/)
    await expect(
      svc.invoke('save', { repoPath: repo, id: made.id, title: 'Kept' }),
    ).resolves.toBeTruthy()
  })
})
