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
      jobs?: { publish?: { needs?: string } }
    }
    expect(parsed.on?.workflow_dispatch).toBeDefined()
    expect(parsed.jobs?.publish?.needs).toBe('build')
  })

  it('can only be invoked explicitly for stable or edge', () => {
    expect(desktopWorkflow).toContain('workflow_dispatch:')
    expect(desktopWorkflow).not.toMatch(/^\s+push:/m)
    expect(desktopWorkflow).toContain('- edge')
    expect(desktopWorkflow).toContain('- stable')
  })

  it('builds Linux and Apple Silicon macOS with signing before an atomic upload', () => {
    expect(desktopWorkflow).toContain('release_notes:')
    expect(desktopWorkflow).toContain('TAURI_SIGNING_PRIVATE_KEY:')
    expect(desktopWorkflow).toContain('TAURI_SIGNING_PRIVATE_KEY_PASSWORD:')
    expect(desktopWorkflow).toContain('libwebkit2gtk-4.1-dev')
    expect(desktopWorkflow).toContain('blacksmith-6vcpu-macos-15')
    expect(desktopWorkflow).toContain('target: darwin-aarch64')
    expect(desktopWorkflow).toContain('--target aarch64-apple-darwin')
    expect(desktopWorkflow).toContain('APPLE_SIGNING_IDENTITY:')
    expect(desktopWorkflow).toContain('apple_signing_identity: "-"')
    expect(desktopWorkflow).toContain('*.dmg')
    expect(desktopWorkflow).toContain('*.app.tar.gz')
    expect(desktopWorkflow).toContain('actions/upload-artifact@v4')
    expect(desktopWorkflow).toContain('actions/download-artifact@v4')
    const validation = desktopWorkflow.indexOf('--validate-only')
    const build = desktopWorkflow.indexOf('bun run --cwd apps/desktop build')
    const collect = desktopWorkflow.indexOf('actions/download-artifact@v4')
    const prepare = desktopWorkflow.lastIndexOf('bun scripts/desktop-release.ts')
    const upload = desktopWorkflow.indexOf('gh release upload')
    expect(validation).toBeGreaterThan(0)
    expect(build).toBeGreaterThan(validation)
    expect(collect).toBeGreaterThan(build)
    expect(prepare).toBeGreaterThan(collect)
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
