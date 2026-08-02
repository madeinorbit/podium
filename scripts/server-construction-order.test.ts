import { describe, expect, it } from 'vitest'
import { auditConstructionSource } from './server-construction-order'

const root = (body: string): string => `
class SessionRegistry {
  modules: unknown
  constructor() {
${body}
  }
}
`

describe('server construction order audit', () => {
  it('accepts dependencies on earlier declarations', () => {
    const audit = auditConstructionSource(
      root(`    const bus = {}
    const sessions = { bus }
    this.modules = { sessions }`),
    )
    expect(audit.steps.map((step) => step.name)).toEqual(['bus', 'sessions'])
    expect(audit.steps[1]?.dependencies).toEqual(['bus'])
  })

  it('rejects a future service hidden inside a thunk', () => {
    expect(() =>
      auditConstructionSource(
        root(`    const sessions = { issues: () => issues }
    const issues = {}`),
      ),
    ).toThrow('sessions at line 5 depends on later service(s): issues')
  })

  it('rejects non-null assertions and property reads before assignment', () => {
    expect(() => auditConstructionSource(root(`    const sessions = future!`))).toThrow(
      'non-null late binding',
    )
    expect(() =>
      auditConstructionSource(
        root(`    const adapter = () => this.modules
    this.modules = { adapter }`),
      ),
    ).toThrow('this.modules is read')
  })
})
