import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import agentSmokeConfig from '../vitest.agent-smoke.config'
import rootConfig from '../vitest.config'
import integrationConfig from '../vitest.integration.config'
import unitConfig from '../vitest.unit.config'

type Project = string | { test?: { name?: string; exclude?: string[]; retry?: number } }
type Config = {
  test?: {
    env?: Record<string, string>
    exclude?: string[]
    include?: string[]
    projects?: Project[]
    retry?: number
  }
}

const config = (value: unknown): Config => value as Config
const nodeProject = (value: unknown) => {
  const project = config(value).test?.projects?.find(
    (candidate): candidate is Exclude<Project, string> =>
      typeof candidate !== 'string' && candidate.test?.name === 'node',
  )
  if (!project) throw new Error('node Vitest project is missing')
  return project
}

describe('test lane configuration', () => {
  it('never collects ignored nested worktrees', () => {
    expect(nodeProject(rootConfig).test?.exclude).toContain('**/.worktrees/**')
  })

  it('keeps retries out of the default project and scopes them to integration', () => {
    expect(nodeProject(rootConfig).test?.retry).toBeUndefined()
    expect(config(unitConfig).test?.retry).toBe(0)
    expect(config(integrationConfig).test?.retry).toBe(1)
  })

  it('keeps deterministic integration and real-agent smoke scopes explicit', () => {
    expect(config(integrationConfig).test?.include).toContain('apps/daemon/src/daemon.test.ts')
    expect(config(integrationConfig).test?.exclude).toContain('**/*.smoke.test.{ts,tsx}')
    expect(config(integrationConfig).test?.projects).toBeUndefined()
    // The smoke config must NOT set PODIUM_REAL_CLI via test.env: vitest writes test.env
    // into worker process.env before files load, which would defeat the opt-in gate and
    // launch real agent CLIs on a bare `vitest run --config vitest.agent-smoke.config.ts`.
    // The opt-in lives in the `test:smoke:agents` script instead (asserted below).
    expect(config(agentSmokeConfig).test?.env?.PODIUM_REAL_CLI).toBeUndefined()
    expect(config(agentSmokeConfig).test?.projects).toBeUndefined()
    expect(config(agentSmokeConfig).test?.exclude).toContain('apps/web/**')
  })

  it('runs the web project exactly once in the default scripts', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(pkg.scripts['test:unit']).toContain('--project node')
    expect(pkg.scripts.test).toContain('test:web')
    expect(pkg.scripts.test).not.toContain('test:integration')
    expect(pkg.scripts.test).not.toContain('test:smoke:agents')
    expect(pkg.scripts['test:e2e']).toContain('NODE_OPTIONS=--conditions=@podium/source')
    expect(pkg.scripts['test:smoke:agents']).toContain('PODIUM_REAL_CLI=1')
  })

  it('runs every vitest invocation under the Bun runtime [spec:SP-3f93]', () => {
    // The suite must exercise bun:sqlite and Bun process semantics, so a bare `vitest run`
    // (Node runtime) in any script is doctrine drift — POD-622 caught test:multi-instance
    // regressing this way. Every vitest call must be spelled `bun --bun vitest`.
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      scripts: Record<string, string>
    }
    for (const [name, script] of Object.entries(pkg.scripts)) {
      for (const match of script.matchAll(/(?:^|&&|\|\|)\s*([^&|]*\bvitest\b[^&|]*)/g)) {
        expect(match[1].trim(), `script "${name}" must run vitest via bun --bun`).toMatch(
          /^(?:[A-Z_]+=\S+\s+)*bun --bun vitest\b/,
        )
      }
    }
  })
})
