/**
 * NO PAYLOAD ISSUED FROM THIS PAGE CARRIES IDENTITY (POD-646).
 *
 * §3.1.3 A3 and ADR 3 D7: actor, on-behalf-of and owner are stamped by the
 * authority from the authenticated transport, and identity in a command payload
 * is inert at best and a forgery seam at worst. The requirement is therefore an
 * ABSENCE, and an absence is the hardest thing to keep true — nothing fails when
 * someone adds `origin: 'human'` to a patch, and it would look helpful.
 *
 * This is a source-scanning check, so it carries the hazard every source scan
 * has: a scan that matches NOTHING passes every assertion it makes. The first
 * test therefore proves the instrument can SEE the files before any absence is
 * believed — the "prove it can say yes" rule from the POD-330 ownership map §4b.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const HERE = join(import.meta.dirname)
const COMMANDS = join(HERE, '..', 'issue-page-commands.ts')

/** Every source file this page issues writes from. */
function pageSources(): { path: string; text: string }[] {
  const files = readdirSync(HERE)
    .filter((f) => (f.endsWith('.ts') || f.endsWith('.tsx')) && !f.includes('.test.'))
    .map((f) => join(HERE, f))
  return [COMMANDS, ...files].map((path) => ({ path, text: readFileSync(path, 'utf8') }))
}

/** A payload key assignment: `actor:`, `owner:`, `onBehalfOf:`, `origin:` used
 *  as an object key rather than as a READ of a server field (`issue.owner`). */
const IDENTITY_KEY = /(?<![.\w])(actor|owner|onBehalfOf|origin|visibility)\s*:/g

describe('the instrument can see what it claims to check', () => {
  it('reads a non-trivial set of page sources', () => {
    const sources = pageSources()
    expect(sources.length).toBeGreaterThan(10)
    expect(sources.every((s) => s.text.length > 0)).toBe(true)
  })

  it('would MATCH an identity key if one were written — the positive control', () => {
    // Without this, "no matches" is indistinguishable from a regex that matches
    // nothing at all.
    const planted = 'trpc.issues.update.mutate({ id, patch: { owner: "alice" } })'
    expect(planted.match(IDENTITY_KEY)).not.toBeNull()
  })
})

describe('no command payload carries actor, owner, origin or visibility', () => {
  it('finds no identity key written into any payload', () => {
    const offenders: string[] = []
    for (const { path, text } of pageSources()) {
      for (const line of text.split('\n')) {
        // Comments and JSX prop/type positions are not payloads. A payload key
        // appears inside a mutate/update object literal, which in this codebase
        // is always on a line that also mentions one of those.
        const trimmed = line.trim()
        if (trimmed.startsWith('*') || trimmed.startsWith('//')) continue
        if (!/mutate\(|patch:|update\(/.test(line)) continue
        IDENTITY_KEY.lastIndex = 0
        if (IDENTITY_KEY.test(line)) offenders.push(`${path}: ${trimmed}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('the commands module names no identity concept at all', () => {
    // Broader than the payload scan and deliberately so: `issue-page-commands.ts`
    // is the ONLY place this page issues writes from, so any mention of these
    // words there is worth a human look even in a comment.
    const text = readFileSync(COMMANDS, 'utf8')
    expect(text).not.toMatch(/\bonBehalfOf\b/)
    expect(text).not.toMatch(/\bactor\b/)
  })
})
