/**
 * The executable half of POD-1958's guard.
 *
 * `branded-ref.type-test.ts` proves that a mismatched brand is REJECTED at
 * compile time. Two things it cannot prove live here:
 *
 *  1. that {@link brandedRef} still declares a foreign key at all. It returns
 *     the builder unchanged and emits nothing of its own, so a version that
 *     dropped the `.references()` call would typecheck perfectly, satisfy every
 *     `@ts-expect-error` in the fixture, and silently strip every FK from the
 *     next `drizzle-kit generate`. Reading the built table's foreign keys is the
 *     only thing that can tell the difference.
 *  2. that `schema.ts` goes through the helper. The check binds a site only when
 *     that site calls it, and drizzle's own `.references()` is still a method on
 *     every column builder — one autocomplete away from putting the hole back
 *     with no diagnostic anywhere.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getTableConfig } from 'drizzle-orm/sqlite-core'
import { describe, expect, it } from 'vitest'
import { automationRuns, automations, issueDeps, issues, sessionObservationRebinds } from './schema'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Source with block and line comments removed — the header prose names
 *  `.references(` several times and must not count as a use. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

describe('brandedRef', () => {
  it('still declares the foreign key it wraps', () => {
    const { foreignKeys } = getTableConfig(automationRuns)
    const references = foreignKeys.map((fk) => {
      const { columns, foreignColumns } = fk.reference()
      return {
        from: columns.map((c) => c.name),
        to: foreignColumns.map((c) => c.name),
        onDelete: fk.onDelete,
      }
    })
    expect(references).toContainEqual({
      from: ['automation_id'],
      to: ['id'],
      onDelete: 'cascade',
    })
  })

  it('keeps the foreign keys on every table it was adopted at', () => {
    for (const table of [issues, issueDeps, sessionObservationRebinds, automationRuns]) {
      expect(getTableConfig(table).foreignKeys.length).toBeGreaterThan(0)
    }
  })

  it('leaves the referenced primary keys branded', () => {
    // A brand is type-level and emits no SQL, so nothing at runtime can read it
    // back. What CAN be read is that the columns the foreign keys point at are
    // still the primary keys they were declared against — the far side of the
    // pair the type check compares.
    expect(getTableConfig(automations).columns.find((c) => c.name === 'id')?.primary).toBe(true)
    expect(getTableConfig(issues).columns.find((c) => c.name === 'id')?.primary).toBe(true)
  })
})

describe('schema.ts', () => {
  it('declares every foreign key through brandedRef, never drizzle .references()', () => {
    const source = stripComments(readFileSync(join(HERE, 'schema.ts'), 'utf8'))
    expect(source).not.toMatch(/\.references\s*\(/)
    expect(source).toMatch(/\bbrandedRef\s*\(/)
  })

  it('keeps the negative fixture planted', () => {
    const fixture = readFileSync(join(HERE, 'branded-ref.type-test.ts'), 'utf8')
    // Each directive is a mismatch tsc must still reject; an unused one fails
    // the typecheck, so the only way to weaken this fixture is to delete lines.
    const planted = fixture.match(/@ts-expect-error/g) ?? []
    expect(planted.length).toBeGreaterThanOrEqual(4)
  })
})
