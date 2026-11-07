import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const scripts = join(__dirname, '../apps/desktop/scripts')
const scratch: string[] = []
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
})

function fixture(failures: number) {
  const dir = mkdtempSync(join(tmpdir(), 'apple-service-retry-'))
  scratch.push(dir)
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  const command = (name: string, body: string) => {
    const path = join(bin, name)
    writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`)
    chmodSync(path, 0o755)
    return path
  }
  command('sleep', 'printf "%s\\n" "$1" >> "$APPLE_RETRY_TEST_DIR/delays"')
  const probe = command(
    'probe',
    `key="$1"
count_file="$APPLE_RETRY_TEST_DIR/$key-count"
count=0
if [ -f "$count_file" ]; then count="$(cat "$count_file")"; fi
count=$((count + 1))
printf '%s\\n' "$count" > "$count_file"
printf '%s\\n' "$@" >> "$APPLE_RETRY_TEST_DIR/args"
if [ "$count" -le "$APPLE_RETRY_TEST_FAILURES" ]; then
  echo 'The network connection was lost.' >&2
  exit 68
fi
echo 'ticket valid'`,
  )
  const run = (script: string, args: string[] = [], extraEnv = {}) => {
    // The verifier tees to /dev/stderr. Bun's captured child pipe is a socket on
    // Linux, so give that descriptor a file that tee can reopen, as on the Mac runner.
    const stderrPath = join(dir, 'stderr')
    const stderr = openSync(stderrPath, 'w')
    try {
      const result = spawnSync('bash', [script, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', stderr],
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          APPLE_RETRY_TEST_DIR: dir,
          APPLE_RETRY_TEST_FAILURES: String(failures),
          ...extraEnv,
        },
      })
      return { ...result, stderr: readFileSync(stderrPath, 'utf8') }
    } finally {
      closeSync(stderr)
    }
  }
  const lines = (name: string) =>
    existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8').trim().split('\n') : []
  return { dir, command, probe, run, lines }
}

function runProbe(failures: number) {
  const f = fixture(failures)
  const script = join(f.dir, 'run.sh')
  writeFileSync(
    script,
    'set -euo pipefail\nsource "$1"\nretry_apple_service "$2" probe "a bundle.app"\necho continued\n',
  )
  return { ...f, result: f.run(script, [join(scripts, 'apple-service-retry.sh'), f.probe]) }
}

describe('Apple service retries', () => {
  it('returns immediately when the service succeeds', () => {
    const f = runProbe(0)
    expect(f.result.status).toBe(0)
    expect(f.lines('probe-count')).toEqual(['1'])
    expect(f.lines('delays')).toEqual([])
  })

  it('recovers from dropped connections and preserves arguments with spaces', () => {
    const f = runProbe(2)
    expect(f.result.status).toBe(0)
    expect(f.result.stdout).toContain('continued')
    expect(f.lines('probe-count')).toEqual(['3'])
    expect(f.lines('delays')).toEqual(['15', '30'])
    expect(f.lines('args')).toEqual(Array(3).fill(['probe', 'a bundle.app']).flat())
  })

  it('stops after five failures and preserves the failing exit status', () => {
    const f = runProbe(99)
    expect(f.result.status).toBe(68)
    expect(f.result.stdout).not.toContain('continued')
    expect(f.result.stderr).toContain('failed after 5 attempts')
    expect(f.lines('probe-count')).toEqual(['5'])
    expect(f.lines('delays')).toEqual(['15', '30', '60', '120'])
  })

  it('retries DMG ticket calls without repeating signing or submission', () => {
    const f = fixture(2)
    const bundle = join(f.dir, 'bundle with spaces')
    mkdirSync(join(bundle, 'dmg'), { recursive: true })
    writeFileSync(join(bundle, 'dmg/Podium.dmg'), '')
    f.command('codesign', 'echo signed >> "$APPLE_RETRY_TEST_DIR/signing"')
    f.command(
      'xcrun',
      `if [ "$1" = notarytool ]; then
  echo submitted >> "$APPLE_RETRY_TEST_DIR/submissions"
else
  exec "$(dirname "$0")/probe" "$2" "$3"
fi`,
    )
    const result = f.run(join(scripts, 'notarize-dmg.sh'), [bundle], {
      APPLE_SIGNING_IDENTITY: 'test',
      APPLE_API_KEY_PATH: 'test',
      APPLE_API_KEY: 'test',
      APPLE_API_ISSUER: 'test',
    })
    expect(result.status, result.stderr).toBe(0)
    expect(f.lines('signing')).toEqual(['signed'])
    expect(f.lines('submissions')).toEqual(['submitted'])
    expect(f.lines('staple-count')).toEqual(['3'])
    expect(f.lines('validate-count')).toEqual(['3'])
  })

  it.each([2, 99])('runs the macOS verifier through ticket failures (%s)', (failures) => {
    const f = fixture(failures)
    const bundle = join(f.dir, 'bundle')
    const payload = join(bundle, 'macos/Podium.app/Contents/Resources/resources/payload')
    mkdirSync(payload, { recursive: true })
    const cli = join(payload, 'podium-cli')
    writeFileSync(cli, '#!/bin/sh\necho 0.3.0\n')
    chmodSync(cli, 0o755)
    f.command(
      'codesign',
      `case "$1" in
  -dvvv) printf '%s\\n' 'Authority=Developer ID Application: test' 'flags=runtime' ;;
  -d) echo allow-jit ;;
esac`,
    )
    f.command('xattr', 'if [ "$1" = -p ]; then exit 1; fi')
    f.command('xcrun', 'exec "$(dirname "$0")/probe" "$2" "$3"')
    f.command('spctl', '"$(dirname "$0")/probe" assess "$@"\necho "source=Notarized Developer ID"')
    const result = f.run(join(scripts, 'verify-macos-signing.sh'), [bundle])
    expect(result.status, result.stderr).toBe(failures === 2 ? 0 : 1)
    expect(f.lines('validate-count')).toEqual([failures === 2 ? '3' : '5'])
    if (failures === 2) expect(f.lines('assess-count')).toEqual(['3'])
    if (failures === 99) expect(result.stderr).toContain('app has no stapled notarization ticket')
  })
})
