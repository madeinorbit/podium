import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// The lab rig is deliberately untracked. Copy its reviewed artifact to the VM and state its path.
const labDir = process.env.VPS_LAB_TOOLING_DIR

describe.runIf(labDir)('VPS lab creator feed policy', () => {
  it('opts new/reset containers out and provisions snapshots, without running Docker', () => {
    if (!labDir) throw new Error('VPS_LAB_TOOLING_DIR is required')
    const dir = mkdtempSync(join(tmpdir(), 'podium-lab-creator-'))
    try {
      const calls = join(dir, 'calls')
      const mock = join(dir, 'mock.sh')
      writeFileSync(mock, 'docker() { printf "%s\\n" "$*" >> "$LAB_DOCKER_CALLS"; }\n')
      execFileSync('bash', [join(labDir, 'lab'), 'reset', '99', 'clean'], {
        env: {
          ...process.env,
          HOME: dir,
          BASH_ENV: mock,
          LAB_DOCKER_CALLS: calls,
        },
      })
      const requests = readFileSync(calls, 'utf8')
      expect(requests).toContain('--env PODIUM_UPDATE_FEED_POLLING=off')
      expect(requests).toContain('exec vps99 sh /tmp/podium-lab-feed-policy.sh')
      expect(requests).toContain(
        'provision/update-feed-policy.sh vps99:/tmp/podium-lab-feed-policy.sh',
      )
      expect(readFileSync(join(labDir, 'Dockerfile'), 'utf8')).toContain(
        'ENV PODIUM_UPDATE_FEED_POLLING=off',
      )
      expect(readFileSync(join(labDir, 'provision/update-feed-policy.sh'), 'utf8')).toBe(
        readFileSync(join(import.meta.dirname, 'test-instance-feed-policy.sh'), 'utf8'),
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
