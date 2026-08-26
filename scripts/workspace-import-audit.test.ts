import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { auditWorkspaceImports } from './workspace-import-audit'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

describe('Podium workspace imports', () => {
  it('declares every imported workspace package from its owning manifest', () => {
    const audit = auditWorkspaceImports(repoRoot)
    expect(audit.imports.length).toBeGreaterThan(0)
    expect(audit.declarationViolations).toEqual([])
  })

  it('resolves every import to this checkout source under @podium/source', () => {
    const result = spawnSync(
      process.execPath,
      [
        '--conditions=@podium/source',
        fileURLToPath(new URL('./workspace-import-audit.ts', import.meta.url)),
        '--resolve',
      ],
      { cwd: repoRoot, encoding: 'utf8' },
    )
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0)
    expect(result.stdout).toContain('resolve to this checkout source')
  })

  it('detects a fixture import with no manifest edge', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'podium-workspace-import-audit-'))
    try {
      writeFileSync(
        join(fixture, 'package.json'),
        JSON.stringify({ private: true, workspaces: ['packages/*', 'tests/*'] }),
      )
      mkdirSync(join(fixture, 'packages/model/src'), { recursive: true })
      writeFileSync(
        join(fixture, 'packages/model/package.json'),
        JSON.stringify({
          name: '@podium/model',
          exports: { '.': './src/index.ts' },
        }),
      )
      mkdirSync(join(fixture, 'tests/fixture'), { recursive: true })
      writeFileSync(
        join(fixture, 'tests/fixture/package.json'),
        JSON.stringify({ name: '@podium/fixture', dependencies: {} }),
      )
      writeFileSync(
        join(fixture, 'tests/fixture/entry.ts'),
        "import type { SessionId } from '@podium/model'\n",
      )

      expect(auditWorkspaceImports(fixture).declarationViolations).toEqual([
        expect.objectContaining({
          file: 'tests/fixture/entry.ts',
          specifier: '@podium/model',
        }),
      ])
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('detects undeclared third-party imports but ignores builtins and aliases', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'podium-third-party-import-audit-'))
    try {
      writeFileSync(
        join(fixture, 'package.json'),
        JSON.stringify({ private: true, workspaces: ['packages/*'] }),
      )
      mkdirSync(join(fixture, 'packages/fixture'), { recursive: true })
      writeFileSync(
        join(fixture, 'packages/fixture/package.json'),
        JSON.stringify({ name: '@podium/fixture', dependencies: {} }),
      )
      writeFileSync(
        join(fixture, 'packages/fixture/entry.ts'),
        "import 'node:fs'\nimport '@/local'\nimport 'left-pad'\nvi.mock('tinyspy')\n",
      )

      const audit = auditWorkspaceImports(fixture)
      expect(audit.thirdPartyImports.map(({ specifier }) => specifier)).toEqual([
        'left-pad',
        'tinyspy',
      ])
      expect(audit.thirdPartyDeclarationViolations.map(({ specifier }) => specifier)).toEqual([
        'left-pad',
        'tinyspy',
      ])
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })
})
