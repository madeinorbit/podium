import { expect, it } from 'vitest'
import { MODEL_CLASSES, type ModelHost } from './models'

/**
 * POD-5370: Vite, Bun and this runner DEFINE a constructor parameter property
 * (own property over anything on the prototype); Babel's TypeScript transform,
 * which the phone's Metro build uses, ASSIGNS it, so a prototype accessor of
 * the same name intercepts it (a getter-only one throws). Every model must
 * construct the same way under both, which this checks by doing the
 * assignment the phone build's constructor does.
 */
it('every model member assigns as the phone build constructs it, through no prototype accessor', () => {
  for (const [entity, Model] of Object.entries(MODEL_CLASSES)) {
    const defined = new Model('row-1', {} as ModelHost) as unknown as Record<string, unknown>
    const assigned = Object.create(Model.prototype) as Record<string, unknown>
    for (const member of Object.keys(defined)) {
      expect(() => {
        assigned[member] = defined[member]
      }, `${entity}.${member}`).not.toThrow()
      expect(Object.hasOwn(assigned, member), `${entity}.${member} is the instance's own`).toBe(true)
      expect(assigned[member], `${entity}.${member}`).toBe(defined[member])
    }
    expect(assigned.id, `${entity}.id`).toBe('row-1')
  }
})
