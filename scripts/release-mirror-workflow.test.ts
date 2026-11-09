import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

type Step = { name?: string; id?: string; if?: string; env?: Record<string, string>; run?: string }
type Job = {
  if?: string
  needs?: unknown
  permissions?: Record<string, string>
  env?: Record<string, string>
  steps: Step[]
}
const root = join(__dirname, '..')
const workflow = (name: string) =>
  Bun.YAML.parse(readFileSync(join(root, '.github/workflows', name), 'utf8')) as {
    jobs: Record<string, Job>
  }
const expression = (value: string) => `\${{ ${value} }}`
const expected = {
  PODIUM_PUBLISH_RELEASE_MIRROR: expression('vars.PODIUM_PUBLISH_RELEASE_MIRROR'),
  PODIUM_RELEASE_R2_ENDPOINT: expression('vars.PODIUM_RELEASE_R2_ENDPOINT'),
  PODIUM_RELEASE_R2_BUCKET: expression('vars.PODIUM_RELEASE_R2_BUCKET'),
  AWS_ACCESS_KEY_ID: expression('secrets.PODIUM_RELEASE_R2_ACCESS_KEY_ID'),
  AWS_SECRET_ACCESS_KEY: expression('secrets.PODIUM_RELEASE_R2_SECRET_ACCESS_KEY'),
}

describe('release mirror activation wiring', () => {
  it('gives the publishing job scoped secrets, keeps the switch explicit, and checks the S3 client first', () => {
    const publish = workflow('release.yml').jobs.publish!
    expect(publish.env).toMatchObject(expected)
    const setup = publish.steps.findIndex(
      (step) => step.name === 'Prepare mirror publishing client',
    )
    const upload = publish.steps.findIndex(
      (step) => step.name === 'Publish one multi-platform release',
    )
    expect(setup).toBeGreaterThan(-1)
    expect(setup).toBeLessThan(upload)
    expect(publish.steps[setup]!.if).toBe("vars.PODIUM_PUBLISH_RELEASE_MIRROR == '1'")
  })

  it('mirrors accepted desktop bytes after a GitHub upload failure without skipping the candidate gate', () => {
    const jobs = workflow('desktop-release.yml').jobs
    const publish = Object.values(jobs).find((job) =>
      job.steps?.some((step) => step.id === 'desktop_inventory'),
    )!
    expect(publish).toBeDefined()
    const mirror = publish.steps.find(
      (step) => step.name === 'Publish the validated desktop inventory to R2',
    )!
    expect(mirror.env).toMatchObject(expected)
    expect(mirror.if).toContain('always()')
    expect(mirror.if).toContain("steps.desktop_inventory.outcome == 'success'")
    expect(mirror.if).toContain('!cancelled()')
    expect(mirror.if).toContain("vars.PODIUM_PUBLISH_RELEASE_MIRROR == '1'")
    expect(mirror.run).toContain('scripts/release-mirror.ts')
  })

  it('offers a read-only GitHub backfill job with no build dependency and a real failover proof', () => {
    const jobs = workflow('release.yml').jobs
    const backfill = jobs['mirror-backfill']!
    expect(backfill.permissions).toEqual({ contents: 'read' })
    expect(backfill.needs).toBeUndefined()
    expect(backfill.env).toMatchObject({ ...expected, PODIUM_PUBLISH_RELEASE_MIRROR: '1' })
    expect(jobs.headless!.if).toContain("inputs.mirror_backfill == 'off'")
    expect(backfill.steps.some((step) => step.run?.includes('release:prepare'))).toBe(false)
    expect(
      backfill.steps.some(
        (step) =>
          step.run?.includes('release-mirror-backfill.ts') && step.run.includes('--execute'),
      ),
    ).toBe(true)
    expect(backfill.steps.some((step) => step.run?.includes('verify-live-release-mirror.ts'))).toBe(
      true,
    )
  })

  it('does not install tools when publishing is off and does not print credential values on refusal', () => {
    const script = join(root, 'scripts/setup-release-mirror.sh')
    const off = spawnSync('bash', [script], {
      env: { PATH: process.env.PATH, PODIUM_PUBLISH_RELEASE_MIRROR: '0' },
      encoding: 'utf8',
    })
    expect(off.status).toBe(0)
    expect(off.stdout).toBe('')
    const missing = spawnSync('bash', [script], {
      env: {
        PATH: process.env.PATH,
        PODIUM_PUBLISH_RELEASE_MIRROR: '1',
        AWS_SECRET_ACCESS_KEY: 'never-log-this-value',
      },
      encoding: 'utf8',
    })
    expect(missing.status).toBe(1)
    expect(missing.stderr).toContain('PODIUM_RELEASE_R2_ENDPOINT')
    expect(missing.stderr).not.toContain('never-log-this-value')
  })
})
