/**
 * WHAT A HOME SHARES WITH THE PERSON'S OWN HARNESS DIRECTORY (credential
 * management §10 "Homes"; measured in POD-6893 S2).
 *
 * A second account must not behave like a fresh install, so a home links the
 * person's settings, instructions, skills and plugins from the harness's
 * default directory. Both harnesses read through the links and write through
 * them without replacing them (S2), so a change the person makes in either
 * place is one change.
 *
 * Never linked: the login (that is what the home is for), conversations and
 * harness state, and Claude Code's `.claude.json`, which holds the signed-in
 * identity as well as onboarding, folder trust and the person's user-scope MCP
 * servers. That file is the home's own: seeded so the first turn is not a
 * theme picker and a trust prompt, and given the person's `mcpServers` at
 * every launch. Codex's hooks are not linked either: Podium's own reach a
 * home at launch as `-c` flags (`codex-hook-trust.ts`).
 */

import { existsSync, lstatSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import {
  antigravityHomeSharing,
  claudeHomeSharing,
  codexHomeSharing,
  prepareAntigravityHomeLaunch,
  prepareClaudeHomeLaunch,
} from '@podium/harness'
import type { HomeHarness } from '@podium/protocol'
import type { HarnessHome } from './registry'

/** What a home links from the default directory, per harness (S2). */
export const SHARED_ENTRIES = {
  [claudeHomeSharing[0]]: claudeHomeSharing[1],
  [codexHomeSharing[0]]: codexHomeSharing[1],
  [antigravityHomeSharing[0]]: antigravityHomeSharing[1],
} satisfies Readonly<Record<HomeHarness, readonly string[]>>

/**
 * Link every shared entry the person has into the home. An entry the person
 * does not have yet gets no link (a dangling link would make the harness
 * create the person's file on its first write); it is linked at a later
 * launch, once it exists. An entry the home already holds, link or file, is
 * left as it is.
 */
export function linkShared(home: HarnessHome, defaultDir: string): { linked: string[] } {
  const linked: string[] = []
  for (const name of SHARED_ENTRIES[home.harness]) {
    const source = join(defaultDir, name)
    const target = join(home.dir, name)
    if (!existsSync(source) || occupied(target)) continue
    symlinkSync(source, target)
    linked.push(name)
  }
  return { linked }
}

export interface HomeLaunchInput {
  /** The harness's own directory (`~/.claude`, `~/.codex`) on this machine. */
  defaultDir: string
  /** The session's working directory, trusted in a Claude home. A terminal
   *  needs it (Claude asks before its first turn there); a headless or stream
   *  run never asks, so it may leave it out. */
  cwd?: string
  /** The person's own Claude Code state file (`~/.claude.json`), read only. */
  personClaudeState?: string
}

/** Everything a home needs right before a session starts in it. */
export function prepareHomeLaunch(home: HarnessHome, input: HomeLaunchInput): void {
  linkShared(home, input.defaultDir)
  prepareClaudeHomeLaunch(home, input)
  prepareAntigravityHomeLaunch(home, input)
}

function occupied(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}
