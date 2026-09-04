/**
 * THE OPENCODE LOGIN, INSIDE AN ISOLATED HOME (POD-2772).
 *
 * ---------------------------------------------------------------------------
 * WHY A LANE THAT WANTS AN ISOLATED HOME STILL NEEDS THIS
 * ---------------------------------------------------------------------------
 *
 * Handing the daemon `discovery.homeDir` is not only a redirect for the
 * scanner. That path becomes the daemon's `ctx.homeDir`, and `ctx.homeDir` is
 * two more things at once:
 *
 *   - the home inventory reads the harness login from
 *     (`harnessDetectLogin` -> `detectOpencodeLogin`), and
 *   - the `HOME` every server-driver child is spawned with
 *     (`serverChildEnv`, which exists precisely so an isolated instance's
 *     children stop reading the operator's real credentials).
 *
 * Point it at a bare `mkdtemp` and inventory reports the harness `out` —
 * correctly, there is no credential under that home. A logged-out harness has
 * no headless path to admit, so the spawn that named `opencode-server` is
 * refused before any server starts, and the lane reported
 * `waitFor(session live): timed out`. That is POD-2772's headline symptom, and
 * seeding the login here is what clears it.
 *
 * WHAT THIS IS *NOT* THE FIX FOR, because the guess was wrong and the wrong
 * guess is worth writing down. POD-2772's report suspected the same empty home
 * one layer down: that `opencode serve`, spawned with `HOME=<empty>`, was
 * starved of provider credentials, which would explain the
 * `waitFor(badge working): timed out` seen at the commit before the login gate
 * landed. It does not. With this seed in place the lane still failed there,
 * and the cause turned out to be the lane's retired model — see
 * `PREFERRED_FREE_MODELS` in the acceptance file. The check that settled it:
 * the dead model answers `UnknownError: Unexpected server error` under the
 * operator's REAL home too, which no credential story survives.
 *
 * So the isolated home has to CARRY the login — which is exactly what
 * `applyRealAgentCodexEnv` in `harness-env.ts` already does for Codex, and this
 * is the same move for opencode.
 *
 * Deliberately NOT in `harness-env.ts`: that module is imported by
 * `playwright.config.ts`, which the Playwright CLI loads outside the
 * `@podium/source` condition, and it holds itself to node builtins for that
 * reason. This one needs the harness package.
 */

import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import { opencodeAuthPath } from '@podium/harness'

export interface SeedOpencodeLoginOptions {
  /** Test hook: the native home holding opencode's credential file. */
  sourceHomeDir?: string
}

/**
 * Copy the operator's opencode credential into `homeDir`, and nothing else.
 *
 * ONLY `auth.json`. The rest of opencode's data root is the conversation store
 * — 243 MB of it on the machine this was written on — and leaving that behind
 * is the entire point of an isolated home. The path comes from the harness
 * package rather than a second copy of the literal here, so this writes the
 * file `detectOpencodeLogin` reads even if that location moves.
 *
 * THROWS rather than skipping when there is no native login. A live lane that
 * quietly opts out on the machines where it would have run is the failure the
 * acceptance file's own gating comment warns about — green while testing
 * nothing.
 *
 * @returns the path written, for a failure message that can name it.
 */
export function seedOpencodeLogin(homeDir: string, options: SeedOpencodeLoginOptions = {}): string {
  const sourceAuth = opencodeAuthPath(options.sourceHomeDir ?? homedir())
  if (!existsSync(sourceAuth)) {
    throw new Error(
      `the live opencode lane needs a native opencode login at ${sourceAuth} — run 'opencode auth login' first`,
    )
  }
  const isolatedAuth = opencodeAuthPath(homeDir)
  // 0700 the whole way down: a credential copy on a shared /tmp is still a
  // credential. chmod AFTER mkdir, because a previous run may have created the
  // tree under a wider umask.
  for (const dir of ancestorsBetween(homeDir, dirname(isolatedAuth))) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
  }
  // Deliberately NOT COPYFILE_EXCL: re-seeding a home this lane owns is a
  // no-op worth allowing, and the caller's `mkdtemp` is fresh anyway.
  copyFileSync(sourceAuth, isolatedAuth)
  chmodSync(isolatedAuth, 0o600)
  return isolatedAuth
}

/** `root` and every directory between it and `leaf`, outermost first. */
function ancestorsBetween(root: string, leaf: string): string[] {
  const chain: string[] = []
  for (let dir = leaf; dir.startsWith(root); dir = dirname(dir)) {
    chain.unshift(dir)
    if (dir === root) break
  }
  return chain
}
