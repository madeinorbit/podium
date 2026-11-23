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
import ts from 'typescript'
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

/** Object literal writes can span lines; response types and reads are allowed. */
function identityWrites(text: string): string[] {
  const ast = ts.createSourceFile('page.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const found: string[] = []
  function visit(node: ts.Node) {
    if (ts.isObjectLiteralExpression(node))
      for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property))
          continue
        const key = ts.isComputedPropertyName(property.name)
          ? property.name.expression
          : property.name
        const name = ts.isIdentifier(key) || ts.isStringLiteral(key) ? key.text : ''
        if (['actor', 'owner', 'onBehalfOf', 'origin', 'visibility'].includes(name))
          found.push(name)
      }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return found
}

describe('the instrument can see what it claims to check', () => {
  it('reads a non-trivial set of page sources', () => {
    const sources = pageSources()
    expect(sources.length).toBeGreaterThan(10)
    expect(sources.every((s) => s.text.length > 0)).toBe(true)
  })
})

describe('no command payload carries actor, owner, origin or visibility', () => {
  it('finds no identity key written into page objects', () => {
    expect(
      pageSources().flatMap(({ path, text }) =>
        identityWrites(text).map((key) => `${path}: ${key}`),
      ),
    ).toEqual([])
  })
  it('detects multiline and shorthand writes while allowing response types and reads', () => {
    expect(
      identityWrites(`mutate({
 actor: 'forged',
 onBehalfOf,
 ['owner']: 'other'
})`),
    ).toEqual(['actor', 'onBehalfOf', 'owner'])
    expect(
      identityWrites(
        `interface Response { actor: string; onBehalfOf: string }; const label = row.actor`,
      ),
    ).toEqual([])
  })
})
