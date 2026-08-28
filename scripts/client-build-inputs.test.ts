import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { declaredBuildInputs, requiredBuildInputs } from './client-build-inputs'

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
})
