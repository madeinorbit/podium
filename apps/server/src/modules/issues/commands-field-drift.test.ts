import { ISSUE_COLOR_SLOTS } from '@podium/domain'
import { ISSUE_COMMANDS } from '@podium/issue-client'
import { IssueColor } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { issueRegistry } from './registry'

/**
 * FIELD-level drift pins (#347). The name-level drift test
 * (packages/issue-client/src/commands.drift.test.ts) only guards command NAMES;
 * a flag existing on one side but not the other (the `--audience` asymmetry that
 * motivated #346/#347) sailed through it. The CLI table is presentation over the
 * server registry, so shapes are not 1:1 — these tests pin the two highest-risk
 * WRITE commands (create, update) field-by-field through the CLI→proc alias map,
 * with every intentional gap named and justified. Add a field to one side
 * without the other and this fails the same day.
 */

const shapeKeys = (schema: unknown): Set<string> =>
  new Set(Object.keys((schema as z.ZodObject<z.ZodRawShape>).shape))

const cliShape = (name: string): Set<string> => {
  const cmd = ISSUE_COMMANDS.find((c) => c.name === name)
  if (!cmd) throw new Error(`no CLI command ${name}`)
  return shapeKeys(cmd.args)
}

/** CLI flag → proc field renames (the CLI's friendlier verbs). */
const CLI_ALIASES: Record<string, string> = {
  agent: 'defaultAgent',
  model: 'defaultModel',
  effort: 'defaultEffort',
  machine: 'machineId',
  start: 'startNow',
}

const mapCliKeys = (keys: Set<string>): Set<string> =>
  new Set([...keys].map((k) => CLI_ALIASES[k] ?? k))

describe('CLI table ↔ server registry FIELD drift (#347)', () => {
  it('update: every server patch field is settable from the CLI, and vice versa', () => {
    const serverInput = issueRegistry.defs.update.input as z.ZodObject<z.ZodRawShape>
    const patchKeys = shapeKeys(serverInput.shape.patch)
    // Intentional gaps — each must stay justified:
    //  - archived: the CLI exposes it as the dedicated `archive` command.
    patchKeys.delete('archived')
    const cliKeys = mapCliKeys(cliShape('update'))
    cliKeys.delete('id') // outer input field, not part of the patch
    expect([...cliKeys].sort()).toEqual([...patchKeys].sort())
  })

  it('create: every server create field is settable from the CLI, and vice versa', () => {
    const serverKeys = shapeKeys(issueRegistry.defs.create.input)
    // Intentional gaps — each must stay justified:
    //  - linear: set by the Linear import integration, not a human/agent flag;
    //  - mutationId: sync/idempotency plumbing, supplied by transports;
    //  - origin: DERIVED from the caller, never accepted (#198/#348).
    for (const k of ['linear', 'mutationId']) serverKeys.delete(k)
    expect(serverKeys.has('origin')).toBe(false) // forgeable-provenance regression guard
    const cliKeys = mapCliKeys(cliShape('create'))
    expect([...cliKeys].sort()).toEqual([...serverKeys].sort())
  })

  it('attachSession: newSubissue accepts no origin (derived from the caller, #348)', () => {
    const input = issueRegistry.defs.attachSession.input as z.ZodObject<z.ZodRawShape>
    const sub = input.shape.newSubissue as z.ZodOptional<z.ZodObject<z.ZodRawShape>>
    expect(Object.keys(sub.unwrap().shape)).toEqual(['title'])
    expect(input.safeParse({ sessionId: 's1', confirmRehome: true }).success).toBe(true)
  })

  it('issue colour palette: the protocol wire enum mirrors the domain slot list [spec:SP-b4d1]', () => {
    // Domain is a zero-dependency leaf and protocol stays dependency-free, so
    // the 10 slot names are declared in both — this pin is what keeps them one.
    expect(IssueColor.options).toEqual([...ISSUE_COLOR_SLOTS])
  })

  it('accepts palette slot names on create/update and null only on update', () => {
    const create = issueRegistry.defs.create.input
    const update = issueRegistry.defs.update.input
    expect(
      create.safeParse({ repoPath: '/r', title: 'x', startNow: false, color: 'violet' }).success,
    ).toBe(true)
    expect(
      create.safeParse({ repoPath: '/r', title: 'x', startNow: false, color: null }).success,
    ).toBe(false)
    expect(update.safeParse({ id: '1', patch: { color: 'teal' } }).success).toBe(true)
    expect(update.safeParse({ id: '1', patch: { color: null } }).success).toBe(true)
    expect(update.safeParse({ id: '1', patch: { color: '#14b8a6' } }).success).toBe(false)
    expect(update.safeParse({ id: '1', patch: { color: 'amber' } }).success).toBe(false)
  })

  it('every CLI command arg schema is strict (unknown flags are rejected, #345)', () => {
    for (const cmd of ISSUE_COMMANDS) {
      const res = cmd.args.safeParse({
        __definitely_not_a_flag__: 1,
        // minimally-plausible required fields so ONLY the unknown key can fail
        id: '1',
        repoPath: '/r',
        title: 't',
        body: 'b',
        author: 'x',
        assignee: 'x',
        fromId: '1',
        toId: '2',
        type: 'blocks',
        parent: 'p',
        text: 't',
        query: 'q',
      })
      expect(res.success, `${cmd.name} accepted an unknown key`).toBe(false)
      if (!res.success) {
        expect(
          res.error.issues.some((i) => i.code === 'unrecognized_keys'),
          `${cmd.name} failed for a different reason than the unknown key`,
        ).toBe(true)
      }
    }
  })
})
