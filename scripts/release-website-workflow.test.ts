import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..')
const release = Bun.YAML.parse(
  readFileSync(join(root, '.github/workflows/release.yml'), 'utf8'),
) as {
  jobs: Record<
    string,
    { needs: string; if: string; uses: string; secrets?: Record<string, string> }
  >
}
const website = Bun.YAML.parse(
  readFileSync(join(root, '.github/workflows/release-website.yml'), 'utf8'),
) as {
  on: Record<string, unknown>
  permissions: Record<string, string>
  jobs: { refresh: { steps: Array<{ name: string; run: string; env: Record<string, string> }> } }
}

describe('release website CI hook', () => {
  it('runs after published smoke and allows only stable tag publication', () => {
    const job = release.jobs.website
    expect(job?.needs).toBe('published-smoke')
    const evaluate = new Function('github', 'startsWith', 'contains', `return ${job?.if}`)
    const allowed = (event: string, tag: string) =>
      evaluate(
        { event_name: event, ref: `refs/tags/${tag}`, ref_name: tag },
        (s: string, prefix: string) => s.startsWith(prefix),
        (s: string, part: string) => s.includes(part),
      )
    expect(allowed('push', 'v0.3.1')).toBe(true)
    expect(allowed('push', 'v0.3.1-edge.1')).toBe(false)
    expect(allowed('workflow_dispatch', 'v0.3.1')).toBe(false)
  })
  it('supports an isolated retry for a published release and separates token scopes', () => {
    expect(Object.keys(release.jobs.website?.secrets ?? {})).toEqual([
      'PODIUM_WEBSITE_DISPATCH_TOKEN',
    ])
    expect(website.on.workflow_dispatch).toBeDefined()
    expect(website.on.workflow_call).toBeDefined()
    expect(website.permissions).toMatchObject({ contents: 'read', actions: 'read' })
    const [wait, dispatch] = website.jobs.refresh.steps
    expect(wait?.env.GH_TOKEN).toContain('github.token')
    expect(dispatch?.env.GH_TOKEN).toContain('secrets.PODIUM_WEBSITE_DISPATCH_TOKEN')
    expect(dispatch?.run).toContain('workflows/site.yml/dispatches')
    expect(dispatch?.run).not.toContain('inputs:')
    expect(dispatch?.run).toContain('--exit-status')
  })
})
