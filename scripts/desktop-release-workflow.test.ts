import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = join(__dirname, '..')
const desktopWorkflow = readFileSync(
  join(repoRoot, '.github/workflows/desktop-release.yml'),
  'utf8',
)
const headlessWorkflow = readFileSync(join(repoRoot, '.github/workflows/release.yml'), 'utf8')
const releaseSource = readFileSync(join(repoRoot, 'scripts/release.ts'), 'utf8')

describe('desktop release workflow', () => {
  it('parses as a GitHub workflow with workflow_dispatch', () => {
    const parsed = Bun.YAML.parse(desktopWorkflow) as {
      on?: { workflow_dispatch?: unknown }
    }
    expect(parsed.on?.workflow_dispatch).toBeDefined()
  })

  it('can only be invoked explicitly for stable or edge', () => {
    expect(desktopWorkflow).toContain('workflow_dispatch:')
    expect(desktopWorkflow).not.toMatch(/^\s+push:/m)
    expect(desktopWorkflow).toContain('- edge')
    expect(desktopWorkflow).toContain('- stable')
  })

  it('builds with signing secrets and validates before upload', () => {
    expect(desktopWorkflow).toContain('release_notes:')
    expect(desktopWorkflow).toContain('TAURI_SIGNING_PRIVATE_KEY:')
    expect(desktopWorkflow).toContain('TAURI_SIGNING_PRIVATE_KEY_PASSWORD:')
    const validation = desktopWorkflow.indexOf('--validate-only')
    const build = desktopWorkflow.indexOf('bun run --cwd apps/desktop build')
    const prepare = desktopWorkflow.lastIndexOf('bun scripts/desktop-release.ts')
    const upload = desktopWorkflow.indexOf('gh release upload')
    expect(validation).toBeGreaterThan(0)
    expect(build).toBeGreaterThan(validation)
    expect(prepare).toBeGreaterThan(build)
    expect(prepare).toBeGreaterThan(0)
    expect(upload).toBeGreaterThan(prepare)
  })

  it('keeps ordinary main releases headless-only without deleting desktop assets', () => {
    expect(headlessWorkflow).toContain('branches: [main]')
    expect(headlessWorkflow).not.toContain('TAURI_SIGNING_PRIVATE_KEY')
    expect(headlessWorkflow).not.toContain('apps/desktop')
    expect(releaseSource).not.toContain('release delete edge')
    expect(releaseSource).toContain("['release', 'upload', 'edge', ...assets, '--clobber']")
  })
})
