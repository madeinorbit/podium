import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { vi } from 'vitest'

/** Linux/macOS command-boundary tests: never contact the host's service manager. */
export function fakeSystemctl(state = 'disabled') {
  const dir = mkdtempSync(join(tmpdir(), 'podium-systemctl-'))
  writeFileSync(
    join(dir, 'systemctl'),
    `#!/bin/sh
case "$2" in
  is-active) exit 0 ;;
  is-enabled) printf '%s\\n' "$PODIUM_TEST_UNIT_FILE_STATE" ;;
  *) exit 99 ;;
esac
`,
    { mode: 0o755 },
  )
  vi.stubEnv('PATH', `${dir}${delimiter}${process.env.PATH ?? ''}`)
  vi.stubEnv('PODIUM_TEST_UNIT_FILE_STATE', state)
  return () => {
    vi.unstubAllEnvs()
    rmSync(dir, { recursive: true, force: true })
  }
}
