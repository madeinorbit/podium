import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { launcherShim } from './build-bun'

// A `podium-cli` stub standing in for the real compiled CLI: it prints exactly what the
// launcher exported + the args it was handed, so we can assert what the shim resolved.
const CLI_STUB = '#!/bin/sh\necho "PODIUM_HOME=$PODIUM_HOME"\necho "ARGS=$*"\n'

// The ORIGINAL buggy shim (resolves DIR from `dirname "$0"`, no symlink resolution). Kept
// here so the test can prove RED: invoked via a symlink it resolves DIR to the symlink's own
// dir (BIN), not the real bundle (DEST) — which is the bug this fix closes.
const BUGGY_SHIM = `#!/bin/sh
DIR="$(cd "$(dirname "$0")" && pwd)"
export PODIUM_HOME="$DIR"
export PODIUM_WEB_DIR="\${PODIUM_WEB_DIR:-$DIR/web}"
exec "$DIR/podium-cli" "$@"
`

function writeExec(path: string, body: string): string {
  writeFileSync(path, body)
  chmodSync(path, 0o755)
  return path
}

describe('launcher shim symlink resolution', () => {
  let work: string
  let dest: string // the real bundle dir (…/share/podium), holds podium + podium-cli
  let bin: string // the PATH dir (…/.local/bin) that holds the `podium` symlink

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'podium-shim-test-'))
    dest = join(work, 'share', 'podium')
    bin = join(work, 'bin')
    execFileSync('mkdir', ['-p', dest, bin])
  })
  afterEach(() => rmSync(work, { recursive: true, force: true }))

  it('RED — old shim: invoked via symlink it resolves PODIUM_HOME to BIN, not the bundle', () => {
    writeExec(join(dest, 'podium'), BUGGY_SHIM)
    writeExec(join(dest, 'podium-cli'), CLI_STUB)
    // A cli stub next to the symlink lets us OBSERVE the mis-resolution: the buggy shim
    // computes DIR=BIN and execs BIN/podium-cli, which prints PODIUM_HOME=BIN. (In a real
    // install there is no BIN/podium-cli, so the same bug just makes `podium` fail outright.)
    writeExec(join(bin, 'podium-cli'), CLI_STUB)
    const link = writeSymlink(join(dest, 'podium'), join(bin, 'podium'))
    const out = execFileSync(link, ['daemon'], { encoding: 'utf8' })
    expect(out).toContain(`PODIUM_HOME=${bin}`) // the bug: wrong bundle root
    expect(out).not.toContain(`PODIUM_HOME=${dest}`)
  })

  it('GREEN — fixed shim: through the symlink PODIUM_HOME + podium-cli resolve to the bundle', () => {
    writeExec(join(dest, 'podium'), launcherShim())
    writeExec(join(dest, 'podium-cli'), CLI_STUB)
    const link = writeSymlink(join(dest, 'podium'), join(bin, 'podium'))
    const out = execFileSync(link, ['daemon'], { encoding: 'utf8' })
    expect(out).toContain(`PODIUM_HOME=${dest}`) // the real bundle, not BIN
    expect(out).not.toContain(`PODIUM_HOME=${bin}`)
    expect(out).toContain('ARGS=daemon')
  })

  it('GREEN — fixed shim: direct invocation (no symlink) still resolves to the bundle', () => {
    const shim = writeExec(join(dest, 'podium'), launcherShim())
    writeExec(join(dest, 'podium-cli'), CLI_STUB)
    const out = execFileSync(shim, ['daemon'], { encoding: 'utf8' })
    expect(out).toContain(`PODIUM_HOME=${dest}`)
    expect(out).toContain('ARGS=daemon')
  })
})

function writeSymlink(target: string, link: string): string {
  symlinkSync(target, link)
  return link
}
