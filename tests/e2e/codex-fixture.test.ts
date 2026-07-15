import { mkdirSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { codexStartupFixtureConfig, writeCodexStartupFixture } from './codex-fixture'

describe('Codex startup fixture', () => {
  const root = join(tmpdir(), `podium-codex-fixture-${process.pid}`)

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('writes canonical trusted projects and configured personality deterministically', () => {
    const home = join(root, 'home', '.codex')
    const projectB = join(root, 'project-b')
    const projectA = join(root, 'project-a')
    const aliasA = join(root, 'alias-a')
    mkdirSync(projectA, { recursive: true })
    mkdirSync(projectB, { recursive: true })
    symlinkSync(projectA, aliasA)

    const configPath = writeCodexStartupFixture(home, [projectB, aliasA, projectA])

    expect(readFileSync(configPath, 'utf8')).toBe(
      `personality = "none"\n\n` +
        `[projects.${JSON.stringify(projectA)}]\ntrust_level = "trusted"\n\n` +
        `[projects.${JSON.stringify(projectB)}]\ntrust_level = "trusted"\n`,
    )
    expect(statSync(home).mode & 0o777).toBe(0o700)
    expect(statSync(configPath).mode & 0o777).toBe(0o600)
  })

  it('can configure personality without a project table', () => {
    expect(codexStartupFixtureConfig([])).toBe('personality = "none"\n')
  })
})
