import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HarnessAccountScope } from '../../manifest.js'
import type { ModelChoice } from '../../model-probe.js'

/** The measured files a second Claude login shares with the person's default. */
export const claudeHomeSharing = [
  'claude-code',
  ['settings.json', 'CLAUDE.md', 'skills', 'agents', 'commands', 'plugins'],
] as const

/** The existing home launch inputs; the host supplies paths, never its own state. */
export interface ClaudeHomeLaunchInput {
  cwd?: string
  personClaudeState?: string
}

/** Prepare only Claude's own home state. Other harnesses need no such file. */
export function prepareClaudeHomeLaunch(
  home: { harness: string; dir: string },
  input: ClaudeHomeLaunchInput,
): void {
  if (home.harness === 'claude-code') prepareClaudeState(home.dir, input)
}

/** Propagated macOS Claude logins live in Keychain, so file removal cannot revoke them. */
export function claudeLoginFileRemovalError(harness: string, platform: string): string | undefined {
  return harness === 'claude-code' && platform === 'darwin'
    ? 'a Claude Code login on macOS is not a file'
    : undefined
}

/** A subscription home uses its own login for Claude's model catalog. */
export async function probeClaudeHomeModels(
  harness: string,
  account: HarnessAccountScope,
  probe: (account: HarnessAccountScope) => Promise<ModelChoice[]>,
): Promise<ModelChoice[]> {
  return harness === 'claude-code' ? await probe(account) : []
}

/**
 * The home's `.claude.json`: onboarding done, the session's folder trusted,
 * and the person's MCP servers copied in (a server the home added for itself
 * stays). Everything else in it is the home's own and is kept, its signed-in
 * identity above all. Written only when something changed, by rename, so a
 * Claude process reading it never sees half a file.
 */
function prepareClaudeState(homeDir: string, input: ClaudeHomeLaunchInput): void {
  const path = join(homeDir, '.claude.json')
  const current = readObject(path)
  // A file that is there but cannot be read as an object (Claude mid-write, a
  // hand edit) is left alone: rewriting it would drop the home's identity.
  if (!current && existsSync(path)) return
  const next: Record<string, unknown> = { ...(current ?? {}) }
  next.hasCompletedOnboarding = true
  const person = input.personClaudeState ? readObject(input.personClaudeState) : undefined
  const personServers = asObject(person?.mcpServers)
  if (personServers) next.mcpServers = { ...asObject(next.mcpServers), ...personServers }
  if (input.cwd !== undefined) {
    const projects = { ...asObject(next.projects) }
    projects[input.cwd] = { ...asObject(projects[input.cwd]), hasTrustDialogAccepted: true }
    next.projects = projects
  }
  if (current && JSON.stringify(current) === JSON.stringify(next)) return
  const temporary = `${path}.podium-${process.pid}`
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, path)
}

function readObject(path: string): Record<string, unknown> | undefined {
  try {
    return asObject(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return undefined
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
