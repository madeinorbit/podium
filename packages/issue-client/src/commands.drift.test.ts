import { ISSUE_COMMAND_NAMES, type IssueCommandName } from '@podium/protocol'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import type { IssueTrpc } from './client.js'
import { ISSUE_COMMANDS } from './commands.js'

/**
 * CLI-table drift pins (#248 [spec:SP-3fe2]). The `podium issue` command table
 * is PRESENTATION (verbs, positionals, render bodies) over the shared command
 * name contract: its run() bodies compile against `IssueTrpc`, whose issues
 * record is keyed by @podium/protocol's ISSUE_COMMAND_NAMES — the same union
 * the server registry is satisfies-checked against. These tests pin the
 * type-level linkage and catch runtime drift a rename could smuggle past.
 */

describe('CLI table ↔ protocol command-name drift', () => {
  it("IssueTrpc.issues is keyed by the protocol's canonical name union (type-level)", () => {
    expectTypeOf<keyof IssueTrpc['issues']>().toEqualTypeOf<IssueCommandName>()
  })

  it('every proc a command body can call exists in the canonical list (runtime probe)', async () => {
    // Drive each command's run() against a recording client: any proc name it
    // touches must be a canonical command name. A renamed/removed proc would
    // already fail compilation via IssueTrpc; this guards the `as never` casts
    // some bodies use around partial inputs.
    const names = new Set<string>(ISSUE_COMMAND_NAMES)
    const touched = new Set<string>()
    const recorder = new Proxy(
      {},
      {
        get: (_t, router) =>
          new Proxy(
            {},
            {
              get: (_t2, proc) => {
                if (typeof router === 'string' && typeof proc === 'string' && router === 'issues') {
                  touched.add(proc)
                }
                const call = async () => {
                  throw new Error('probe stop')
                }
                return { query: call, mutate: call }
              },
            },
          ),
      },
    ) as IssueTrpc
    for (const cmd of ISSUE_COMMANDS) {
      // Feed minimally-plausible args; bodies throw on the first call — fine,
      // the proc name has been recorded by then.
      await cmd
        .run(recorder, {
          id: '1',
          ids: '1',
          fromId: '1',
          toId: '2',
          oldId: '1',
          newId: '2',
          canonicalId: '2',
          repoPath: '/r',
          title: 't',
          body: 'b',
          author: 'a',
          assignee: 'a',
          labels: 'x',
          until: '2026-01-01',
          kind: 'rebase',
          sub: 'pending',
          ref: '1',
          set: 's',
          since: 0,
        })
        .catch(() => {})
    }
    expect(touched.size).toBeGreaterThan(0)
    const unknown = [...touched].filter((p) => !names.has(p))
    expect(unknown).toEqual([])
  })

  it('documents lifecycle repair scope on every affected CLI/MCP command', () => {
    for (const name of ['archive', 'supersede', 'duplicate', 'dep-remove', 'reparent']) {
      const command = ISSUE_COMMANDS.find((entry) => entry.name === name)
      expect(command?.summary, name).toContain('outside-scope')
      expect(command?.summary, name).toMatch(/subtree|in-subtree/)
    }
  })

  it('command verbs are unique and every entry declares a summary + zod args', () => {
    const verbs = ISSUE_COMMANDS.map((c) => c.name)
    expect(new Set(verbs).size).toBe(verbs.length)
    for (const c of ISSUE_COMMANDS) {
      expect(c.summary.length).toBeGreaterThan(0)
      expect(typeof c.args.safeParse).toBe('function')
    }
  })

  it('forwards colour slots on create and maps update --color none to null', async () => {
    const createMutate = vi.fn(async () => ({ seq: 1, title: 'Tinted' }))
    const updateMutate = vi.fn(async () => ({ seq: 1 }))
    const client = {
      issues: {
        create: { mutate: createMutate },
        update: { mutate: updateMutate },
      },
    } as unknown as IssueTrpc
    const create = ISSUE_COMMANDS.find((entry) => entry.name === 'create')
    const update = ISSUE_COMMANDS.find((entry) => entry.name === 'update')
    expect(create).toBeDefined()
    expect(update).toBeDefined()
    if (!create || !update) throw new Error('missing create/update command')

    await create.run(client, {
      repoPath: '/r',
      title: 'Tinted',
      color: 'violet',
      start: false,
    })
    await update.run(client, { id: '1', color: 'none' })

    expect(createMutate).toHaveBeenCalledWith(
      expect.objectContaining({ repoPath: '/r', title: 'Tinted', color: 'violet' }),
    )
    expect(updateMutate).toHaveBeenCalledWith({ id: '1', patch: { color: null } })
  })
})
