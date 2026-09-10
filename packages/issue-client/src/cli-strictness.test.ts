import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ISSUE_COMMANDS } from './commands.js'
import { LOCK_COMMANDS } from './lock-commands.js'
import { SPEC_COMMANDS } from './spec-commands.js'

/**
 * THE STRICTNESS TRIPWIRE (POD-3836, contract POD-339).
 *
 * ---------------------------------------------------------------------------
 * WHAT IT PINS
 * ---------------------------------------------------------------------------
 * Every command in the CLI's registries validates argv through its `args`
 * schema, and every one of those schemas must REJECT a key it does not declare.
 * A non-strict `z.object` STRIPS the key instead, which is how `podium lock
 * acquire x --ttlx 1s` granted the two-minute default while the caller believed
 * they had asked for one second — a lease that expires under whoever holds it.
 *
 * The CLI's argv parser (apps/cli/src/argv.ts) refuses an undeclared flag before
 * a schema is ever reached, and that is the wall that produces the good error
 * message. This is the SECOND wall, and it is here because the first one is a
 * per-tool adoption while this is a property of the registry itself: a command
 * added tomorrow gets it whether or not its parser was wired correctly.
 *
 * ---------------------------------------------------------------------------
 * WHY IT COVERS THESE REGISTRIES AND NOT `@podium/commands`
 * ---------------------------------------------------------------------------
 * The documented exception the issue asks for. `@podium/commands`' L1 contracts
 * are the tRPC/relay/ws command plane, and every contract that declares `cli`
 * exposure declares `trpc` or `relay` alongside it — there is no CLI-only
 * contract in that package. Their inputs therefore cross a VERSION BOUNDARY,
 * where this repo's stated rule (packages/protocol/src/version.ts,
 * schema-digest.ts) is that additive fields negotiate by capability: a newer
 * peer may legitimately send a field an older server has never heard of, and
 * `.strict()` there would turn a rolling upgrade into a wall of refusals. That
 * is a wire decision, not an argv one.
 *
 * Nothing is lost at the CLI seam by leaving them alone, because the CLI never
 * forwards an undeclared flag: the parser refused it one layer earlier.
 *
 * ---------------------------------------------------------------------------
 * THE INSTRUMENT IS VERIFIED BEFORE IT IS TRUSTED
 * ---------------------------------------------------------------------------
 * `rejectsUnknownKeys` is proved to fire on a plain `z.object` below, so a green
 * run of the roster cases is evidence rather than a predicate that returns true
 * for everything.
 */

/** Does `schema` REFUSE an undeclared key, rather than stripping it? */
function rejectsUnknownKeys(schema: z.ZodType): boolean {
  const shape = (schema as unknown as { shape?: Record<string, z.ZodTypeAny> }).shape ?? {}
  // A plausible value for every declared key, so the ONLY thing the schema can
  // object to is the key that is not declared. Without this, a missing required
  // field would fail the parse and read as strictness that is not there.
  const filled: Record<string, unknown> = {}
  for (const key of Object.keys(shape)) filled[key] = '1'
  const result = schema.safeParse({ ...filled, __podiumUndeclaredFlag: 'x' })
  if (result.success) return false
  return result.error.issues.some((issue) => issue.code === 'unrecognized_keys')
}

const REGISTRIES = [
  ['ISSUE_COMMANDS', ISSUE_COMMANDS],
  ['SPEC_COMMANDS', SPEC_COMMANDS],
  ['LOCK_COMMANDS', LOCK_COMMANDS],
] as const

describe('the strictness tripwire is an instrument that can say no', () => {
  it('passes a strictObject', () => {
    expect(rejectsUnknownKeys(z.strictObject({ id: z.string() }))).toBe(true)
  })

  it('FAILS a plain object, which strips the key instead of refusing it', () => {
    expect(rejectsUnknownKeys(z.object({ id: z.string() }))).toBe(false)
  })

  it('does not mistake a missing required field for strictness', () => {
    // The filled-shape step is what makes this true; drop it and this case is
    // the one that turns the whole roster green for the wrong reason.
    expect(rejectsUnknownKeys(z.object({ id: z.string(), other: z.string() }))).toBe(false)
  })
})

describe.each(REGISTRIES)('%s rejects unknown flags', (_name, commands) => {
  it('has commands to check', () => {
    expect(commands.length).toBeGreaterThan(0)
  })

  it.each(commands.map((c) => [c.name, c] as const))('%s', (_commandName, command) => {
    expect(rejectsUnknownKeys(command.args)).toBe(true)
  })
})
