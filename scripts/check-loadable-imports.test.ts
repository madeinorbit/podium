import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { unresolvedImports } from './check-loadable-imports'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'podium-e2e-imports-'))
  roots.push(root)
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true })
    writeFileSync(join(root, rel), body)
  }
  return root
}

describe('unresolvedImports [POD-4664]', () => {
  it('names a deleted module the harness still imports', () => {
    // The POD-4472 shape: the module is gone, the import is not.
    const root = tree({
      'daemon/daemon.ts': 'export const startDaemon = 1\n',
      'e2e/serve-harness.ts':
        "import { ensurePodiumCodexHooks } from '../daemon/codex-hooks'\n" +
        "import { startDaemon } from '../daemon/daemon'\n" +
        'console.log(ensurePodiumCodexHooks, startDaemon)\n',
    })
    expect(unresolvedImports(join(root, 'e2e'))).toEqual([
      expect.objectContaining({ file: 'serve-harness.ts', specifier: '../daemon/codex-hooks' }),
    ])
  })

  it('checks re-exports, side-effect and dynamic imports, in nested directories', () => {
    const root = tree({
      'browser/_harness.ts': "export { gone } from './gone-a'\n",
      'browser/spec.browser.e2e.ts':
        "import './gone-b'\nconst m = await import('./gone-c')\nconsole.log(m)\n",
    })
    expect(unresolvedImports(root).map((failure) => failure.specifier).sort()).toEqual([
      './gone-a',
      './gone-b',
      './gone-c',
    ])
  })

  it('skips what never loads: type-only imports, builtins, and generated directories', () => {
    const root = tree({
      'spec.ts':
        "import type { Gone } from './gone-type'\n" +
        "import { readFileSync } from 'node:fs'\n" +
        'export const read = readFileSync\nexport type Alias = Gone\n',
      'node_modules/pkg/index.ts': "import './gone-in-node-modules'\n",
      'test-results/leftover.ts': "import './gone-in-test-results'\n",
    })
    expect(unresolvedImports(root)).toEqual([])
  })

  it('names a missing workspace package subpath', () => {
    const root = tree({ 'spec.ts': "import { x } from '@podium/no-such-package/sub'\nconsole.log(x)\n" })
    expect(unresolvedImports(root)).toEqual([
      expect.objectContaining({ specifier: '@podium/no-such-package/sub' }),
    ])
  })
})
