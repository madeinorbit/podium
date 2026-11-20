/**
 * WHAT A HOME SHARES, AND WITH WHICH FOLDER (credential management §10
 * "Homes"; measured in POD-6893 S2; managed installs §4.3 and §4.6).
 *
 * A second account must not behave like a fresh install, so a sign-in folder
 * links the settings, instructions, skills and plugins of ONE source folder:
 *
 * - the person's own harness directory, as credential management built it;
 * - the Podium home of the harness, once the machine has a managed install
 *   of it: Podium's side then has one set of settings, and a managed binary
 *   never reads the person's folder through a link (M9).
 *
 * The harnesses read through the links and write through them without
 * replacing them (S2 for Claude Code and Codex; Grok 1.0.89 measured in
 * POD-7370), so a change made in either place is one change.
 *
 * Never linked: the login (that is what the home is for), conversations and
 * harness state, and Claude Code's `.claude.json`, which holds the signed-in
 * identity as well as onboarding, folder trust and the user-scope MCP
 * servers. That file is the home's own: seeded so the first turn is not a
 * theme picker and a trust prompt, and given the source's `mcpServers` at
 * every launch. Codex's hooks are not linked either: Podium's own reach a
 * home at launch as `-c` flags (`codex-hook-trust.ts`). Nor are Grok's
 * `hooks/` and `trusted_folders.toml`: Podium installs its own hook file in
 * each home, and folder trust is the home's own.
 *
 * The Podium home itself links nothing: it is filled from the person's folder
 * by copy (`fill.ts`), once at managed install and again on request.
 */

import { existsSync, lstatSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  claudeHomeSharing,
  codexHomeSharing,
  grokHomeSharing,
  prepareClaudeHomeLaunch,
} from '@podium/harness'
import type { HomeHarness } from '@podium/protocol'
import type { HarnessHome } from './registry'

/** What a home links from its source folder, per harness (S2). */
export const SHARED_ENTRIES = {
  [claudeHomeSharing[0]]: claudeHomeSharing[1],
  [codexHomeSharing[0]]: codexHomeSharing[1],
  [grokHomeSharing[0]]: grokHomeSharing[1],
} satisfies Readonly<Record<HomeHarness, readonly string[]>>

/** What one pass over a home's shared entries did. */
export interface LinkReport {
  /** Linked from the source, where there was nothing. */
  linked: string[]
  /** A link to another folder, replaced by one to the source. */
  repointed: string[]
  /** A link to another folder whose entry the source does not have: removed. */
  unlinked: string[]
  /** A real file or folder of the home's own: left exactly as it is. */
  leftInPlace: string[]
}

/**
 * Link every shared entry the source has into the home.
 *
 * - An entry the source does not have yet gets no link (a dangling link would
 *   make the harness create the source's file on its first write); it is
 *   linked at a later launch, once it exists.
 * - A link already there that points at the source is kept.
 * - A link that points anywhere else is Podium's own, from an earlier source:
 *   it is replaced, or removed when the source has no such entry. Only links
 *   are ever replaced.
 * - A real file or folder is the home's own and is left, and reported.
 */
export function linkShared(home: HarnessHome, sourceDir: string): LinkReport {
  const report: LinkReport = { linked: [], repointed: [], unlinked: [], leftInPlace: [] }
  for (const name of SHARED_ENTRIES[home.harness]) {
    const source = join(sourceDir, name)
    const target = join(home.dir, name)
    const present = entryAt(target)
    const wanted = existsSync(source)
    if (present === 'file') {
      if (wanted) report.leftInPlace.push(name)
      continue
    }
    if (present === 'link') {
      if (wanted && linksTo(target, source)) continue
      unlinkSync(target)
      if (!wanted) {
        report.unlinked.push(name)
        continue
      }
      symlinkSync(source, target)
      report.repointed.push(name)
      continue
    }
    if (!wanted) continue
    symlinkSync(source, target)
    report.linked.push(name)
  }
  return report
}

/** Where a home shares from: a folder and, for Claude Code, its state file. */
export interface ShareSource {
  /** The folder whose settings the home links (`~/.claude`, the Podium home). */
  dir: string
  /** Claude Code's state file there, read only: its `mcpServers` are copied
   *  into the home's own `.claude.json` at each launch. */
  claudeState?: string
}

export interface HomeLaunchInput {
  /**
   * The folder this home shares from. Absent for the Podium home, which
   * shares from nothing: it holds copies of its own.
   */
  shareFrom?: ShareSource
  /** The session's working directory, trusted in a Claude home. A terminal
   *  needs it (Claude asks before its first turn there); a headless or stream
   *  run never asks, so it may leave it out. */
  cwd?: string
  /** The variables the start delivers its credential in (an env delivery):
   *  Claude Code is told the key was approved, so it does not ask. */
  deliveredEnv?: Readonly<Record<string, string>>
}

/** Everything a home needs right before a session starts in it. */
export function prepareHomeLaunch(home: HarnessHome, input: HomeLaunchInput): LinkReport {
  const report = input.shareFrom
    ? linkShared(home, input.shareFrom.dir)
    : { linked: [], repointed: [], unlinked: [], leftInPlace: [] }
  prepareClaudeHomeLaunch(home, {
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    ...(input.shareFrom?.claudeState ? { personClaudeState: input.shareFrom.claudeState } : {}),
    ...(input.deliveredEnv ? { deliveredEnv: input.deliveredEnv } : {}),
  })
  return report
}

/** One sign-in folder's entries after re-pointing them at a new source. */
export interface RepointReport extends LinkReport {
  homeId: string
}

/**
 * Point every given sign-in folder's links at `source` (managed installs
 * §4.6 item 3): run when a managed install appears on a machine that already
 * has sign-in folders. Only links change; a real file in the way is left and
 * reported. Folders of another harness than `harness` are not touched.
 */
export function repointSignInFolders(
  homes: readonly HarnessHome[],
  harness: HomeHarness,
  source: string,
): RepointReport[] {
  return homes
    .filter((home) => home.harness === harness && resolve(home.dir) !== resolve(source))
    .map((home) => ({ homeId: home.homeId, ...linkShared(home, source) }))
}

function entryAt(path: string): 'link' | 'file' | undefined {
  try {
    return lstatSync(path).isSymbolicLink() ? 'link' : 'file'
  } catch {
    return undefined
  }
}

function linksTo(link: string, source: string): boolean {
  try {
    return resolve(join(link, '..'), readlinkSync(link)) === resolve(source)
  } catch {
    return false
  }
}
