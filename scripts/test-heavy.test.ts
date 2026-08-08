import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runWithHeavyTestLease, shouldAcquireHeavyTestLease } from './test-heavy'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fakePodium(alreadyHeld: boolean): {
  env: Record<string, string | undefined>
  log: string
} {
  const dir = mkdtempSync(join(tmpdir(), 'podium-heavy-lease-'))
  tempDirs.push(dir)
  const log = join(dir, 'calls.log')
  const executable = join(dir, 'podium')
  writeFileSync(
    executable,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$HEAVY_TEST_LOG"
if [ "$2" = "acquire" ]; then
  printf '%s\\n' '{"command":"acquire","ok":true,"exitCode":0,"data":{"granted":true,"alreadyHeld":${alreadyHeld}},"text":"lease granted"}'
fi
`,
  )
  chmodSync(executable, 0o755)
  return {
    log,
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ''}`,
      PODIUM_SESSION_ID: 'session-1',
      HEAVY_TEST_LOG: log,
    },
  }
}

describe('shouldAcquireHeavyTestLease', () => {
  it('requires a live session identity', () => {
    expect(shouldAcquireHeavyTestLease({})).toBe(false)
    expect(shouldAcquireHeavyTestLease({ PODIUM_SESSION_ID: 'session-1' })).toBe(true)
  })

  it('does not treat unrelated Podium variables as a session', () => {
    expect(shouldAcquireHeavyTestLease({ PODIUM_INSTANCE: 'default' })).toBe(false)
  })
})

describe('runWithHeavyTestLease', () => {
  it.each([
    { alreadyHeld: true, expectedCalls: ['lock acquire test:heavy --ttl 30m --wait --json'] },
    {
      alreadyHeld: false,
      expectedCalls: ['lock acquire test:heavy --ttl 30m --wait --json', 'lock release test:heavy'],
    },
  ])('releases only a lease opened by this wrapper (already held: $alreadyHeld)', async ({
    alreadyHeld,
    expectedCalls,
  }) => {
    const { env, log } = fakePodium(alreadyHeld)

    await expect(
      runWithHeavyTestLease(['bash', '-c', 'exit 0'], { cwd: process.cwd(), env }),
    ).resolves.toBe(0)
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(expectedCalls)
  })
})
