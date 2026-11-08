import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..')
const source = (path: string) => readFileSync(join(root, path), 'utf8')

describe('explicit test instance polling policy', () => {
  it('provisions a persistent explicit policy for both SSH and user services, idempotently', () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-test-feed-policy-'))
    try {
      mkdirSync(join(dir, 'etc'))
      writeFileSync(join(dir, 'etc/environment'), 'OTHER=value\nPODIUM_UPDATE_FEED_POLLING=on\n')
      for (let run = 0; run < 2; run++)
        execFileSync('sh', [join(root, 'scripts/test-instance-feed-policy.sh'), dir])
      expect(readFileSync(join(dir, 'etc/environment'), 'utf8')).toBe(
        'OTHER=value\nPODIUM_UPDATE_FEED_POLLING=off\n',
      )
      expect(readFileSync(join(dir, 'etc/environment.d/80-podium-update-feed.conf'), 'utf8')).toBe(
        'PODIUM_UPDATE_FEED_POLLING=off\n',
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('opts multi-instance children out before applying test overrides', () => {
    const text = source('scripts/multi-instance-runtime.integration.bun.test.ts')
    const policy = text.indexOf("PODIUM_UPDATE_FEED_POLLING: 'off'")
    expect(policy).toBeGreaterThan(-1)
    expect(policy).toBeLessThan(text.indexOf('Object.entries(overrides)'))
  })

  it('sets Docker-created service and CLI children off, and opts local feed services in', () => {
    expect(source('scripts/docker-update-e2e/provision.sh')).toContain(
      'PODIUM_UPDATE_FEED_POLLING=off',
    )
    const harness = source('scripts/docker-update-e2e.sh')
    expect(
      harness.slice(harness.indexOf('container_exec()'), harness.indexOf('wait_for()')),
    ).toContain('--env PODIUM_UPDATE_FEED_POLLING=off')
    for (const path of [
      'scripts/docker-update-e2e/server-lane.sh',
      'scripts/docker-update-e2e/real-release-lane.sh',
    ]) {
      expect(source(path)).toContain('Environment=PODIUM_UPDATE_FEED_POLLING=on')
    }
  })

  it('keeps the changed fixture shell entry points syntactically valid', () => {
    for (const path of [
      'scripts/docker-update-e2e.sh',
      'scripts/docker-update-e2e/provision.sh',
      'scripts/docker-update-e2e/server-lane.sh',
      'scripts/docker-update-e2e/real-release-lane.sh',
    ]) {
      execFileSync('bash', ['-n', join(root, path)])
    }
  })
})
