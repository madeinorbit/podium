/**
 * Desktop build preflight: detect missing toolchain deps and tell the user EXACTLY how to
 * fix them, instead of letting `tauri build` fail late with a cryptic error (e.g. the
 * `cargo metadata ... No such file` you get when Rust isn't on PATH).
 *
 * We deliberately do NOT install anything — a build script silently curl|sh-ing a system
 * toolchain is an anti-pattern (network mid-build, mutates the user's machine without
 * consent). We detect, instruct, and exit non-zero. The one sanctioned auto-install is
 * rustup honoring rust-toolchain.toml once `cargo` itself is present.
 *
 * Run automatically by `bun run dev` / `bun run build` in apps/desktop.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const os = platform() // 'darwin' | 'linux' | 'win32' | ...
const isMac = os === 'darwin'
const isLinux = os === 'linux'

/** A tool is present if it runs and exits 0. */
const runs = (bin: string, args: string[]): boolean => {
  try {
    return spawnSync(bin, args, { stdio: 'ignore' }).status === 0
  } catch {
    return false
  }
}

type Problem = { what: string; fix: string }
const problems: Problem[] = []

// 1. Rust / cargo — the thing Tauri shells out to. Distinguish "not installed" from
//    "installed but this shell didn't load ~/.cargo/env" (a very common first-run snag).
if (!runs('cargo', ['--version'])) {
  const cargoBin = join(homedir(), '.cargo', 'bin', 'cargo')
  if (existsSync(cargoBin)) {
    problems.push({
      what: "Rust is installed but `cargo` is not on this shell's PATH.",
      fix: 'source "$HOME/.cargo/env"   # then re-run; new terminals load it automatically',
    })
  } else {
    problems.push({
      what: 'Rust toolchain not found (Tauri needs `cargo`).',
      fix: 'curl --proto \'=https\' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y && source "$HOME/.cargo/env"',
    })
  }
}

// 2. A C compiler — build-bun.ts compiles the vendored abduco (cc/gcc/clang) during
//    `package:headless`, which stage-sidecar.ts runs. No compiler => the build dies there.
if (!['cc', 'gcc', 'clang'].some((c) => runs(c, ['--version']))) {
  problems.push({
    what: 'No C compiler found (cc/gcc/clang) — needed to build the embedded abduco.',
    fix: isMac
      ? 'xcode-select --install   # installs the Command Line Tools (clang, linker)'
      : isLinux
        ? 'sudo apt-get install -y build-essential'
        : 'Install a C toolchain (cc/gcc/clang) for your platform.',
  })
}

// 3. Linux-only: the webkit/gtk system libs Tauri links against. Probe via pkg-config.
if (isLinux) {
  const havePkgConfig = runs('pkg-config', ['--version'])
  if (!havePkgConfig) {
    problems.push({
      what: "pkg-config not found (needed to locate Tauri's GTK/WebKit system libs).",
      fix: 'sudo apt-get install -y pkg-config',
    })
  } else {
    const missing = ['webkit2gtk-4.1', 'gtk+-3.0', 'libsoup-3.0'].filter(
      (lib) => !runs('pkg-config', ['--exists', lib]),
    )
    if (missing.length > 0) {
      problems.push({
        what: `Missing Tauri system libraries: ${missing.join(', ')}.`,
        fix: 'sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev librsvg2-dev libayatana-appindicator3-dev libxdo-dev libssl-dev',
      })
    }
  }
}

// 4. Bundle targets must include something the host OS can actually produce, or
//    `tauri build` exits without a usable artifact. Flag a host mismatch rather than letting
//    the user chase an empty output directory.
try {
  const confPath = fileURLToPath(new URL('../src-tauri/tauri.conf.json', import.meta.url))
  const conf = JSON.parse(readFileSync(confPath, 'utf8')) as { bundle?: { targets?: unknown } }
  const targets = conf.bundle?.targets
  if (Array.isArray(targets)) {
    const macTargets = ['app', 'dmg']
    const linuxTargets = ['appimage', 'deb', 'rpm']
    const hostTargets = isMac ? macTargets : isLinux ? linuxTargets : []
    if (hostTargets.length > 0 && !targets.some((t) => hostTargets.includes(String(t)))) {
      problems.push({
        what: `tauri.conf.json bundle.targets (${targets.join(', ')}) has nothing buildable on ${os}.`,
        fix: 'Set "targets": "all" in apps/desktop/src-tauri/tauri.conf.json (Tauri then builds the host-appropriate bundles).',
      })
    }
  }
} catch {
  // If the config can't be read, the later tauri step will surface a clearer error.
}

if (problems.length === 0) {
  console.log('[preflight] ✅ toolchain looks good')
  process.exit(0)
}

console.error('\n[preflight] ❌ desktop build prerequisites are missing:\n')
for (const p of problems) {
  console.error(`  • ${p.what}`)
  console.error(`      fix: ${p.fix}\n`)
}
console.error('Resolve the above, then re-run `bun run build` (or `bun run dev`).\n')
process.exit(1)
