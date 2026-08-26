/**
 * THE RUST GATE for the desktop shell (`apps/desktop/src-tauri`).
 *
 * Why this exists: `logging.rs` and `bootstrap.rs` carry ~20 `#[test]`s covering
 * the native NDJSON sink, rotation, panic payloads, the pending-crash bound and
 * the crash hand-off script — and until this script there was no lane, no CI job
 * and no `package.json` target that ran a single one of them. Inverting the
 * rotation bound passed every gate the repo had. A test nothing runs is not a
 * test, so the fix is a lane, not more tests. [POD-1906, epic review of POD-1897]
 *
 * WHY IT IS NOT JUST `cargo test`. `build.rs` runs `tauri_build`, which REFUSES
 * to build unless every `resources` entry in `tauri.conf.json` exists — and
 * those are produced by `bun run --cwd apps/desktop stage`, i.e. by a full web
 * build plus a compiled `podium` binary. Paying for that to run pure unit tests
 * would make the gate slow enough that it gets skipped. So this script stages
 * EMPTY placeholders for exactly the paths tauri-build probes, runs the tests,
 * and removes only what it created — it never touches a real staged bundle.
 *
 * Run: `bun run test:rust` (own job in .github/workflows/ci.yml). Pass
 * `--if-available` to no-op when the machine has no Rust toolchain; CI passes
 * nothing, so a missing toolchain there is a red gate rather than a silent skip.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const TAURI_DIR = join(REPO_ROOT, 'apps/desktop/src-tauri')

/**
 * Every path tauri-build probes for existence: the `resources` entries of
 * tauri.conf.json, plus its `frontendDist` (checked by `generate_context!`,
 * which is expanded by the TEST target too — `main.rs` has `#[test]`s in the
 * same file). Relative to the tauri dir, as the config writes them.
 */
const BUILD_PLACEHOLDERS = [
  { path: 'resources/web', dir: true },
  { path: 'resources/mobile', dir: true },
  { path: 'resources/licenses', dir: true },
  { path: 'resources/podium', dir: false },
  { path: '../../web/dist', dir: true },
] as const

/** `cargo` from PATH, else rustup's default install. A login shell has it on
 *  PATH and a non-interactive one often does not, which would otherwise read as
 *  "no Rust on this machine". */
export function resolveCargo(env: NodeJS.ProcessEnv = process.env): string | null {
  const probe = spawnSync('cargo', ['--version'], { stdio: 'ignore', env })
  if (probe.status === 0) return 'cargo'
  const fallback = join(env.CARGO_HOME ?? join(homedir(), '.cargo'), 'bin', 'cargo')
  if (existsSync(fallback)) return fallback
  return null
}

/** Create the placeholders that are missing; returns an undo for those only. */
export function stagePlaceholders(tauriDir: string): () => void {
  const created: { abs: string; dir: boolean }[] = []
  for (const { path, dir } of BUILD_PLACEHOLDERS) {
    const abs = join(tauriDir, path)
    if (existsSync(abs)) continue
    if (dir) mkdirSync(abs, { recursive: true })
    else {
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, '')
    }
    created.push({ abs, dir })
  }
  return () => {
    for (const { abs, dir } of created.reverse()) {
      rmSync(abs, { recursive: dir, force: true })
    }
    // The parent `resources/` may itself have been created by the loop above.
    // Removed only when EMPTY, so a real staged bundle is never touched.
    try {
      rmdirSync(join(tauriDir, 'resources'))
    } catch {
      // Not empty, or not there: both mean it is not ours to remove.
    }
  }
}

function main(): number {
  const ifAvailable = process.argv.includes('--if-available')
  const cargo = resolveCargo()
  if (!cargo) {
    const message = 'no `cargo` on PATH or in ~/.cargo/bin — install a Rust toolchain'
    if (ifAvailable) {
      console.log(`test:rust skipped: ${message}`)
      return 0
    }
    console.error(`ERROR: ${message}.\nThe desktop shell's Rust tests are a blocking gate.`)
    return 1
  }
  const undo = stagePlaceholders(TAURI_DIR)
  try {
    const result = spawnSync(cargo, ['test', '--manifest-path', join(TAURI_DIR, 'Cargo.toml')], {
      stdio: 'inherit',
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        // DEBUG INFO OFF, unless the caller asked for it. It is most of the
        // target dir — a debug build of this dep tree runs to several GiB, which
        // is a lane that fails with ENOSPC on a working machine rather than a
        // lane that reports. Assertion failures still name their file and line
        // (that is `panic!`, not DWARF); what is lost is a debugger session,
        // which is not what a CI lane does.
        CARGO_PROFILE_TEST_DEBUG: process.env.CARGO_PROFILE_TEST_DEBUG ?? '0',
        CARGO_PROFILE_DEV_DEBUG: process.env.CARGO_PROFILE_DEV_DEBUG ?? '0',
      },
    })
    return result.status ?? 1
  } finally {
    undo()
  }
}

if (import.meta.main) {
  process.exit(main())
}
