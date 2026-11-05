import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { desktopBuildMatrix } from './desktop-build-legs'

type Step = {
  name?: string
  run?: string
  if?: string
  uses?: string
  with?: Record<string, unknown>
}
type Workflow = {
  on: {
    workflow_dispatch: {
      inputs: Record<string, { type?: string; default?: unknown; options?: string[] }>
    }
  }
  jobs: Record<string, { if?: string; steps: Step[] }>
}
const root = join(__dirname, '..')
const workflow = (name: string) =>
  Bun.YAML.parse(readFileSync(join(root, '.github/workflows', name), 'utf8')) as Workflow
const desktop = workflow('desktop-release.yml')
const headless = workflow('release.yml')
function job(config: Workflow, name: string) {
  const found = config.jobs[name]
  if (!found) throw new Error(`workflow has no ${name} job`)
  return found
}
const desktopValidate = job(desktop, 'validate')
const desktopPublish = job(desktop, 'publish')
const headlessBuild = job(headless, 'headless')
const scratch: string[] = []
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
})

function run(step: Step | undefined, env: Record<string, string>) {
  if (!step?.run) throw new Error('workflow step has no shell to execute')
  const dir = mkdtempSync(join(tmpdir(), 'release-build-only-'))
  scratch.push(dir)
  const output = join(dir, 'output')
  writeFileSync(output, '')
  const result = spawnSync('bash', ['-c', step.run], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      GITHUB_OUTPUT: output,
      INPUT_CHANNEL: '',
      INPUT_RELEASE_TAG: '',
      INPUT_PUBLISH_RELEASE: '',
      GITHUB_REF: '',
      GITHUB_REF_NAME: '',
      GITHUB_SHA: '',
      EVENT_NAME: '',
      ...env,
    },
  })
  const outputs = Object.fromEntries(
    readFileSync(output, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const at = line.indexOf('=')
        return [line.slice(0, at), line.slice(at + 1)]
      }),
  )
  return { ...result, outputs }
}

describe('unpublished release candidates', () => {
  it('keeps publication enabled by default and uses boolean dispatch inputs', () => {
    for (const config of [desktop, headless]) {
      expect(config.on.workflow_dispatch.inputs.publish_release).toMatchObject({
        type: 'boolean',
        default: true,
      })
    }
  })

  it('builds the exact dispatch commit, including Intel, for an unpublished stable candidate', () => {
    const sha = '462172b28a71b19c9215d20dd4af25d5ed6c554e'
    const result = run(
      desktopValidate.steps.find((step) => step.name === 'Resolve channel and ref'),
      {
        GITHUB_EVENT_NAME: 'workflow_dispatch',
        INPUT_CHANNEL: 'stable',
        INPUT_RELEASE_TAG: 'v0.3.0',
        INPUT_PUBLISH_RELEASE: 'false',
        GITHUB_REF: 'refs/heads/candidate',
        GITHUB_SHA: sha,
      },
    )
    expect(result.status, result.stderr).toBe(0)
    expect(result.outputs).toMatchObject({
      channel: 'stable',
      stable_tag: 'v0.3.0',
      checkout_ref: sha,
    })
    expect(
      desktopBuildMatrix('stable')
        .map((leg) => leg.target)
        .sort(),
    ).toEqual(['darwin-aarch64', 'darwin-x86_64', 'linux-x86_64', 'windows-x86_64'])
  })

  it('still builds the immutable stable tag when publishing', () => {
    const result = run(
      desktopValidate.steps.find((step) => step.name === 'Resolve channel and ref'),
      {
        GITHUB_EVENT_NAME: 'workflow_dispatch',
        INPUT_CHANNEL: 'stable',
        INPUT_RELEASE_TAG: 'v0.3.0',
        INPUT_PUBLISH_RELEASE: 'true',
        GITHUB_REF: 'refs/heads/newer-main',
        GITHUB_SHA: 'newer-commit',
      },
    )
    expect(result.status, result.stderr).toBe(0)
    expect(result.outputs.checkout_ref).toBe('v0.3.0')
  })

  it.each(['true', ''])('rejects a publishing stable headless dispatch (%s)', (publish) => {
    const result = run(
      headlessBuild.steps.find((step) => step.name === 'Validate dispatch mode'),
      {
        EVENT_NAME: 'workflow_dispatch',
        INPUT_CHANNEL: 'stable',
        INPUT_PUBLISH_RELEASE: publish,
      },
    )
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('stable dispatches are build-only')
  })

  it.each([
    { event: 'workflow_dispatch', channel: 'stable', publish: 'false' },
    { event: 'workflow_dispatch', channel: 'edge', publish: 'true' },
    { event: 'workflow_dispatch', channel: 'dev', publish: 'true' },
    { event: 'push', channel: '', publish: '' },
  ])('accepts the permitted headless mode $event/$channel/$publish', ({
    event,
    channel,
    publish,
  }) => {
    const result = run(
      headlessBuild.steps.find((step) => step.name === 'Validate dispatch mode'),
      {
        EVENT_NAME: event,
        INPUT_CHANNEL: channel,
        INPUT_PUBLISH_RELEASE: publish,
      },
    )
    expect(result.status, result.stderr).toBe(0)
  })

  it('gates release mutations and retains a candidate manifest as an Actions artifact', () => {
    const publishGuard = "github.event_name != 'workflow_dispatch' || inputs.publish_release"
    expect(job(headless, 'publish').if).toBe(publishGuard)
    expect(job(headless, 'published-smoke').if).toContain(publishGuard)
    const upload = desktopPublish.steps.find(
      (step) => step.name === 'Upload promoted desktop assets',
    )
    expect(upload?.if).toBe(publishGuard)
    const retained = desktopPublish.steps.find(
      (step) => step.name === 'Retain unpublished desktop manifest',
    )
    expect(retained).toMatchObject({
      if: "github.event_name == 'workflow_dispatch' && !inputs.publish_release",
      uses: 'actions/upload-artifact@v4',
      with: { name: 'desktop-candidate-manifest', 'if-no-files-found': 'error' },
    })
  })
})
