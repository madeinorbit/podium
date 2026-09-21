import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  auditClosureAt,
  auditDirectAt,
  auditServerClosureAt,
  extractImports,
  isForbiddenModule,
  isForbiddenSpecifier,
  plant,
  resolveToSource,
} from './audit-harness-entries'

/**
 * The harness entry guard's regression tests (POD-4469). Every arm is shown
 * failing on a planted fixture — a green from a check that cannot go red
 * proves nothing (POD-732) — plus the control that a clean tree stays quiet.
 * `bun scripts/audit-harness-entries.ts --probe` proves the same arms against
 * the shipped script; these pin the functions.
 */

describe('isForbiddenSpecifier', () => {
  it('refuses the host, process and family specifiers', () => {
    for (const spec of [
      'node:child_process',
      'node:net',
      'node:http',
      '@podium/process',
      '@podium/pty',
      './driver/families/terminal/composer-sync',
      '@podium/harness/driver/families/terminal/composer-sync',
    ]) {
      expect(isForbiddenSpecifier(spec)).toBe(true)
    }
  })

  it('allows node:fs, the model, and the contract/store entries', () => {
    for (const spec of [
      'node:fs',
      'node:fs/promises',
      'node:crypto',
      '@podium/model',
      '@podium/harness/driver',
      '@podium/harness/store',
      './contract.js',
      '../store/index.js',
    ]) {
      expect(isForbiddenSpecifier(spec)).toBe(false)
    }
  })
})

describe('isForbiddenModule', () => {
  it('refuses resolved family paths and nothing else', () => {
    expect(isForbiddenModule('packages/harness/src/driver/families/terminal/index.ts')).toBe(true)
    expect(isForbiddenModule('packages/harness/src/driver/contract.ts')).toBe(false)
    expect(isForbiddenModule('packages/harness/src/store/slice.ts')).toBe(false)
  })
})

describe('extractImports', () => {
  it('sees export-from and side-effect imports, skips type-only', () => {
    const refs = extractImports(
      `import { a } from './a'\nimport type { B } from './b'\nexport { c } from './c'\nimport './d'\n`,
    )
    expect(refs).toEqual([
      { specifier: './a', typeOnly: false },
      { specifier: './b', typeOnly: true },
      { specifier: './c', typeOnly: false },
      { specifier: './d', typeOnly: false },
    ])
  })
})

describe('auditDirectAt', () => {
  it('fails a planted forbidden import — the red run', () => {
    const dir = plant({
      'entry.ts': `import { spawn } from 'node:child_process'\nexport const x = spawn\n`,
    })
    try {
      const findings = auditDirectAt(dir, 'probe', 'entry.ts')
      expect(findings.map((f) => f.kind)).toEqual(['direct'])
      expect(findings[0]?.detail).toContain('node:child_process')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('stays quiet on a clean entry — the control', () => {
    const dir = plant({ 'entry.ts': `export * from './a'\n`, 'a.ts': `export const a = 1\n` })
    try {
      expect(auditDirectAt(dir, 'probe', 'entry.ts')).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('auditClosureAt', () => {
  it('fails a forbidden import two hops down — the red run', () => {
    const dir = plant({
      'entry.ts': `export * from './mid'\n`,
      'mid.ts': `export * from './leaf'\n`,
      'leaf.ts': `import { createServer } from 'node:net'\nexport const x = createServer\n`,
    })
    try {
      const findings = auditClosureAt(dir, 'probe', 'entry.ts')
      expect(findings.map((f) => f.kind)).toContain('transitive')
      expect(findings.find((f) => f.kind === 'transitive')?.detail).toContain('node:net')
      expect(findings.find((f) => f.kind === 'transitive')?.detail).toContain('leaf.ts')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails a family-path import even when the module is pure — the red run', () => {
    const dir = plant({
      'entry.ts': `import { y } from './driver/families/x'\nexport const y2 = y\n`,
      'driver/families/x.ts': `export const y = 1\n`,
    })
    try {
      const findings = auditClosureAt(dir, 'probe', 'entry.ts')
      expect(findings.map((f) => f.kind)).toContain('transitive')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('stays quiet on a clean multi-module entry — the control', () => {
    const dir = plant({
      'entry.ts': `export * from './a'\n`,
      'a.ts': `export * from './b'\nimport type { T } from '@podium/model'\nexport type { T }\n`,
      'b.ts': `export const b = 1\n`,
    })
    try {
      expect(auditClosureAt(dir, 'probe', 'entry.ts')).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('auditServerClosureAt', () => {
  it('fails a family module reachable from the server entry — the red run', () => {
    const dir = plant({
      'server.ts': `import { y } from './driver/families/x'\nexport const y2 = y\n`,
      'driver/families/x.ts': `export const y = 1\n`,
    })
    try {
      const { findings } = auditServerClosureAt(dir, 'server.ts')
      expect(findings.map((f) => f.kind)).toEqual(['server-reaches-family'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('resolves the real harness table so the walk is not vacuous', () => {
    // Pinned against the live tree (rooted at this file, never cwd — lane
    // runners execute with a different working directory): if the entries
    // move, the guard must move with them rather than pass on an
    // unresolvable root.
    const root = join(dirname(fileURLToPath(import.meta.url)), '..')
    expect(
      resolveToSource(root, 'packages/harness/src/browser.ts', './store/cursor-codec'),
    ).toBe('packages/harness/src/store/cursor-codec.ts')
    expect(
      resolveToSource(
        root,
        'apps/server/src/modules/superagent/headless.ts',
        '@podium/harness/driver',
      ),
    ).toBe('packages/harness/src/driver.ts')
  })
})
