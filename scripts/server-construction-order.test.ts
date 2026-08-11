import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  auditConstructionSource,
  auditSite,
  findUnenrolledBodies,
  SITES,
} from './server-construction-order'

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

  it('rejects a deferred closure around an already-constructed service', () => {
    expect(() =>
      auditConstructionSource(
        root(`    const issues = {}
    const messages = { issues: () => issues }`),
      ),
    ).toThrow('wraps constructed service issues in a deferred closure')
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

const WIRING_PATH = resolve(
  import.meta.dirname,
  '../apps/server/src/modules/sessions/session-wiring.ts',
)

const wiring = (body: string): string => `
export function wireSessionLifecycle(life: unknown, deps: unknown): void {
  const bag = life as any
${body}
}
`

describe('wiring-site construction order audit', () => {
  it('records earlier assignments read eagerly as dependencies', () => {
    const audit = auditConstructionSource(
      wiring(`  bag.state = new State()
  bag.view = new View({ state: bag.state })`),
      WIRING_PATH,
    )
    expect(audit.steps.map((step) => step.name)).toEqual(['state', 'view'])
    expect(audit.steps[1]?.dependencies).toEqual(['state'])
  })

  it('rejects an eager read of a value assigned further down', () => {
    // The POD-1396 SessionStart defect: a direct reference, not a thunk. The
    // compiler caught this inside the class and stopped once the body moved
    // behind the any-cast.
    expect(() =>
      auditConstructionSource(
        wiring(`  bag.view = new View({ state: bag.state })
  bag.state = new State()`),
        WIRING_PATH,
      ),
    ).toThrow('bag.state is read at line 4 before its assignment at line 5')
  })

  it('allows a deferred read of a value assigned further down', () => {
    const audit = auditConstructionSource(
      wiring(`  bag.view = new View({ state: () => bag.state })
  bag.state = new State()`),
      WIRING_PATH,
    )
    expect(audit.steps.map((step) => step.name)).toEqual(['view', 'state'])
    expect(audit.deferredReads).toBe(1)
  })

  it('checks bare statements at their own position', () => {
    expect(() =>
      auditConstructionSource(
        wiring(`  bag.state.prime()
  bag.state = new State()`),
        WIRING_PATH,
      ),
    ).toThrow('bag.state is read')
  })
})

describe('composition site enrollment', () => {
  it('leaves no large server composition body unwatched', () => {
    expect(findUnenrolledBodies()).toEqual([])
  })

  it('can actually fire — a low threshold finds unenrolled bodies', () => {
    // A gate that never fires proves nothing; this pins that the scan really
    // walks apps/server/src rather than silently matching nothing.
    expect(findUnenrolledBodies(3).length).toBeGreaterThan(0)
  })

  it('enrolls every site it claims to render', () => {
    expect(SITES.map((site) => site.id)).toContain('session-lifecycle-wiring')
    for (const site of SITES) expect(() => auditSite(site)).not.toThrow()
  })
})
