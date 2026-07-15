import { chmodSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function codexStartupFixtureConfig(trustedProjectPaths: readonly string[]): string {
  const projects = Array.from(new Set(trustedProjectPaths.map((path) => realpathSync(path)))).sort()
  const tables = projects
    .map((path) => `[projects.${JSON.stringify(path)}]\ntrust_level = "trusted"`)
    .join('\n\n')
  return `personality = "none"\n${tables ? `\n${tables}\n` : ''}`
}

/**
 * Seed only deterministic, non-secret first-run state into an isolated Codex
 * home. Authentication is supplied separately by the real-agent home fixture.
 * [spec:SP-e639]
 */
export function writeCodexStartupFixture(
  codexHomeDir: string,
  trustedProjectPaths: readonly string[],
): string {
  mkdirSync(codexHomeDir, { recursive: true, mode: 0o700 })
  chmodSync(codexHomeDir, 0o700)
  const configPath = join(codexHomeDir, 'config.toml')
  writeFileSync(configPath, codexStartupFixtureConfig(trustedProjectPaths), { mode: 0o600 })
  chmodSync(configPath, 0o600)
  return configPath
}
