/**
 * CAN THE SKEW DETECTOR SAY BOTH WORDS? (POD-1610)
 *
 * A fingerprint that never differs is a green light with no bulb, and one that
 * differs on a rename-free refactor is a fire alarm in a kitchen. Both halves are
 * pinned here: the changes that make one build unable to read another MUST move
 * the digest, and the changes that do not MUST NOT.
 */

import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { schemaSignature, wireSchemaDigest, wireSchemaSignature } from './schema-digest'

const sig = (schema: z.ZodTypeAny) => schemaSignature(schema)

describe('the wire digest', () => {
  it('is sixteen stable hex digits', () => {
    expect(wireSchemaDigest()).toMatch(/^[0-9a-f]{16}$/)
    expect(wireSchemaDigest()).toBe(wireSchemaDigest())
  })

  it('covers what a client parses AND what it sends', () => {
    const text = wireSchemaSignature()
    expect(text).toContain('feedBootstrap')
    expect(text.startsWith('S=')).toBe(true)
    expect(text).toContain('\nC=')
  })
})

describe('it SAYS YES to changes that are not skew', () => {
  it('ignores field declaration order', () => {
    // Two builds that declare the same message with the fields in a different
    // order describe the same wire. If this moved the digest, every refactor
    // would raise the banner and the banner would stop meaning anything.
    expect(sig(z.object({ a: z.string(), b: z.number() }))).toBe(
      sig(z.object({ b: z.number(), a: z.string() })),
    )
  })

  it('ignores a brand — a compile-time construct with no wire presence', () => {
    expect(sig(z.string().brand<'IssueId'>())).toBe(sig(z.string()))
  })

  it('ignores an error message', () => {
    expect(sig(z.string().min(1, 'required'))).toBe(sig(z.string().min(1, 'MUST be given')))
  })
})

describe('it SAYS NO to the changes that broke POD-1610', () => {
  it('sees a renamed field — the blockedBy → blockedByNotes half', () => {
    expect(sig(z.object({ blockedBy: z.array(z.string()) }))).not.toBe(
      sig(z.object({ blockedByNotes: z.array(z.string()) })),
    )
  })

  it('sees an added union arm — the missing issueProjection half', () => {
    const arm = (kind: string) => z.object({ entity: z.literal(kind), value: z.unknown() })
    const five = z.discriminatedUnion('entity', [arm('session'), arm('issue')])
    const six = z.discriminatedUnion('entity', [
      arm('session'),
      arm('issue'),
      arm('issueProjection'),
    ])
    expect(sig(five)).not.toBe(sig(six))
  })

  it('sees a field become optional', () => {
    expect(sig(z.object({ fromSeq: z.number() }))).not.toBe(
      sig(z.object({ fromSeq: z.number().optional() })),
    )
  })

  it('sees a changed literal and a changed enum', () => {
    expect(sig(z.literal('feedDelta'))).not.toBe(sig(z.literal('feedDelta2')))
    expect(sig(z.enum(['a', 'b']))).not.toBe(sig(z.enum(['a', 'b', 'c'])))
  })

  it('sees a change nested deep inside an array of unions', () => {
    // The real shape: `changes: FeedChange[]` inside a frame envelope. A walker
    // that stopped at the array would have missed the entire outage.
    const frame = (armKinds: string[]) =>
      z.object({
        type: z.literal('feedBootstrap'),
        changes: z.array(
          z.discriminatedUnion(
            'entity',
            armKinds.map((k) => z.object({ entity: z.literal(k) })) as never,
          ),
        ),
      })
    expect(sig(frame(['session', 'issue']))).not.toBe(sig(frame(['session', 'issue', 'repo'])))
  })
})

describe('it terminates on a recursive schema', () => {
  it('does not blow the stack', () => {
    type Node = { child?: Node }
    const node: z.ZodType<Node> = z.lazy(() => z.object({ child: node.optional() }))
    expect(sig(node)).toContain('<cycle>')
  })
})
