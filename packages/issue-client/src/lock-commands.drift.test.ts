import { LOCK_COMMAND_NAMES, type LockCommandName } from '@podium/protocol'
import { describe, expect, expectTypeOf, it } from 'vitest'
import type { IssueTrpc } from './client.js'
import { LOCK_COMMANDS, parseTtl } from './lock-commands.js'

/**
 * Lock CLI-table drift pins [spec:SP-85d1] — the `podium lock` command table is
 * presentation over the protocol's canonical LOCK_COMMAND_NAMES (the same union
 * the server's lock registry is satisfies-checked against). Mirrors
 * commands.drift.test.ts.
 */

describe('lock CLI table ↔ protocol command-name drift', () => {
  it("IssueTrpc.lock is keyed by the protocol's canonical name union (type-level)", () => {
    expectTypeOf<keyof IssueTrpc['lock']>().toEqualTypeOf<LockCommandName>()
  })

  it('every proc a command body can call exists in the canonical list (runtime probe)', async () => {
    const names = new Set<string>(LOCK_COMMAND_NAMES)
    const touched = new Set<string>()
    const recorder = new Proxy(
      {},
      {
        get: (_t, router) =>
          new Proxy(
            {},
            {
              get: (_t2, proc) => {
                if (typeof router === 'string' && typeof proc === 'string' && router === 'lock') {
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
    for (const cmd of LOCK_COMMANDS) {
      await cmd.run(recorder, { name: 'merge:main', repoPath: '/r' }).catch(() => {})
    }
    expect(touched.size).toBeGreaterThan(0)
    const unknown = [...touched].filter((p) => !names.has(p))
    expect(unknown).toEqual([])
  })

  it('command verbs are unique, canonical, and every entry declares a summary + zod args', () => {
    const verbs = LOCK_COMMANDS.map((c) => c.name)
    expect(new Set(verbs).size).toBe(verbs.length)
    expect([...verbs].sort()).toEqual([...LOCK_COMMAND_NAMES].sort())
    for (const c of LOCK_COMMANDS) {
      expect(c.summary.length).toBeGreaterThan(0)
      expect(typeof c.args.safeParse).toBe('function')
    }
  })
})

describe('parseTtl', () => {
  it('parses seconds/minutes/hours and bare seconds', () => {
    expect(parseTtl('30s')).toBe(30)
    expect(parseTtl('10m')).toBe(600)
    expect(parseTtl('2h')).toBe(7200)
    expect(parseTtl('45')).toBe(45)
  })

  it('rejects garbage and non-positive values', () => {
    expect(() => parseTtl('soon')).toThrow(/invalid --ttl/)
    expect(() => parseTtl('0m')).toThrow(/positive/)
  })
})
