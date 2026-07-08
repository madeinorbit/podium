import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { findCoreToHubImports } from './import-boundary'

// The core/hub boundary rule (docs/spec/node-hub-sync.md §2.4): core never
// imports from hub/. Green half runs against the REAL tree — this is the
// enforcement; red half proves the walker actually catches a violation.
describe('core→hub import boundary', () => {
  const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..')
  const fixtures: string[] = []
  afterAll(() => {
    for (const dir of fixtures) rmSync(dir, { recursive: true, force: true })
  })

  it('the real apps/server/src has no core→hub imports (the rule)', () => {
    expect(findCoreToHubImports(srcDir)).toEqual([])
  })

  it('flags a core file importing from hub/ (red case: the walker works)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-hub-boundary-'))
    fixtures.push(dir)
    mkdirSync(join(dir, 'hub'))
    writeFileSync(join(dir, 'hub', 'pairing.ts'), 'export const x = 1\n')
    writeFileSync(join(dir, 'relay.ts'), "import { x } from './hub/pairing'\nexport const y = x\n")
    // hub importing core is FINE (one-directional rule).
    writeFileSync(join(dir, 'hub', 'ok.ts'), "import { y } from '../relay'\nexport const z = y\n")
    expect(findCoreToHubImports(dir)).toEqual(['relay.ts imports ./hub/pairing'])
  })

  it('exempts composition roots and test files (roles.ts manifest)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-hub-boundary-'))
    fixtures.push(dir)
    mkdirSync(join(dir, 'hub'))
    writeFileSync(join(dir, 'hub', 'pairing.ts'), 'export const x = 1\n')
    // server.ts is the composition root: it ACTIVATES hub modules by role.
    writeFileSync(join(dir, 'server.ts'), "import { x } from './hub/pairing'\nexport const y = x\n")
    // A core-located test may construct hub modules to inject them.
    writeFileSync(join(dir, 'relay.test.ts'), "import { x } from './hub/pairing'\nvoid x\n")
    expect(findCoreToHubImports(dir)).toEqual([])
  })

  it('catches re-exports and dynamic imports too', () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-hub-boundary-'))
    fixtures.push(dir)
    mkdirSync(join(dir, 'hub'))
    writeFileSync(join(dir, 'hub', 'thing.ts'), 'export const x = 1\n')
    writeFileSync(join(dir, 'a.ts'), "export { x } from './hub/thing'\n")
    writeFileSync(join(dir, 'b.ts'), "const p = import('./hub/thing')\nexport default p\n")
    expect(findCoreToHubImports(dir).sort()).toEqual([
      'a.ts imports ./hub/thing',
      'b.ts imports ./hub/thing',
    ])
  })
})
