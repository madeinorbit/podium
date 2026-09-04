import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  declaredBuildEnv,
  declaredBuildInputs,
  REQUIRED_BUILD_ENV,
  requiredBuildInputs,
} from './client-build-inputs'

const root = fileURLToPath(new URL('..', import.meta.url))

describe.each(['apps/web', 'apps/mobile'] as const)('%s build inputs', (app) => {
  const task = app === 'apps/web' ? '@podium/web#build' : '@podium/mobile#build'

  it('declares every workspace package the app imports, and the scripts the build runs', () => {
    const declared = new Set(declaredBuildInputs(root, task))
    const missing = requiredBuildInputs(root, app).filter((glob) => !declared.has(glob))
    expect(missing).toEqual([])
  })

  it('excludes its own dist so a restored output cannot feed the next hash', () => {
    expect(declaredBuildInputs(root, task)).toContain('!dist/**')
  })

  it('declares exactly the environment its build actually reads [POD-3082]', () => {
    // The asymmetry is deliberate and its reasons are in REQUIRED_BUILD_ENV's comment:
    // web is keyed on PODIUM_APP_VERSION, mobile is keyed on nothing, because nothing
    // in apps/mobile reads it and the lane re-stamps the version after every build,
    // cached or not. This is the guard against a later tidy-up "restoring consistency"
    // in either direction — each one costs a MISS per release for no output difference.
    expect(declaredBuildEnv(root, task)).toEqual(REQUIRED_BUILD_ENV[task])
  })
})
