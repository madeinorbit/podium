import { describe, expect, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import type {
  CommandAction,
  CommandInput,
  CommandName,
  CommandOutput,
  CommandScope,
} from './commands'
import { type CommandDef, defineCommands } from './commands'

const issues = defineCommands('issues', {
  close: {
    input: z.object({ id: z.string(), reason: z.string().optional() }),
    action: 'write',
    scope: 'issue',
    cli: { positional: ['id'], summary: 'Close an issue' },
  },
  list: {
    input: z.object({ repoId: z.string().optional() }),
    action: 'read',
  },
  archive: {
    input: z.object({ id: z.string() }),
    action: 'manage',
    scope: 'issue',
  },
})

describe('defineCommands (runtime)', () => {
  it('pairs the namespace with the defs verbatim', () => {
    expect(issues.namespace).toBe('issues')
    expect(Object.keys(issues.defs)).toEqual(['close', 'list', 'archive'])
    expect(issues.defs.close.action).toBe('write')
    expect(issues.defs.close.scope).toBe('issue')
    expect(issues.defs.close.cli).toEqual({ positional: ['id'], summary: 'Close an issue' })
    expect(issues.defs.list).not.toHaveProperty('scope')
  })

  it('input schemas are live zod schemas (one validation source)', () => {
    expect(issues.defs.close.input.safeParse({ id: 'podium-7' }).success).toBe(true)
    expect(issues.defs.close.input.safeParse({}).success).toBe(false)
  })
})

describe('command contract (type-level)', () => {
  it('CommandName produces dotted template-literal names', () => {
    expectTypeOf<CommandName<typeof issues>>().toEqualTypeOf<
      'issues.close' | 'issues.list' | 'issues.archive'
    >()
  })

  it('namespace stays a literal type through defineCommands', () => {
    expectTypeOf(issues.namespace).toEqualTypeOf<'issues'>()
  })

  it('CommandInput derives the parsed input type from the zod schema', () => {
    expectTypeOf<CommandInput<typeof issues.defs.close>>().toEqualTypeOf<{
      id: string
      reason?: string | undefined
    }>()
  })

  it('CommandOutput surfaces the Out parameter', () => {
    type Closed = { id: string; stage: 'done' }
    type Def = CommandDef<z.ZodType<{ id: string }>, Closed>
    expectTypeOf<CommandOutput<Def>>().toEqualTypeOf<Closed>()
  })

  it('action reuses the IssueAction vocabulary; scope the SCOPED_TARGET classes', () => {
    // Mirrors packages/domain/src/issue-authz.ts IssueAction exactly.
    expectTypeOf<CommandAction>().toEqualTypeOf<'read' | 'write' | 'manage'>()
    expectTypeOf<CommandScope>().toEqualTypeOf<'issue' | 'repo' | 'global'>()
    defineCommands('bad', {
      // @ts-expect-error 'delete' is not an action — the vocabulary is read/write/manage
      nope: { input: z.object({}), action: 'delete' },
    })
    defineCommands('bad2', {
      // @ts-expect-error 'session' is not a scope class
      nope: { input: z.object({}), action: 'write', scope: 'session' },
    })
  })

  it('defs require a zod input schema', () => {
    defineCommands('bad3', {
      // @ts-expect-error input must be a zod schema
      nope: { input: { id: 'string' }, action: 'read' },
    })
  })
})
