import { describe, expect, it } from 'vitest'
import {
  nodePrerequisiteProblem,
  supportsViteNodeVersion,
  VITE_NODE_VERSION_RANGE,
} from './node-prerequisite'

describe('desktop Node prerequisite', () => {
  it.each([
    'v20.19.0',
    '20.20.1',
    'v22.12.0',
    'v23.0.0',
    'v24.1.0',
  ])('accepts supported Node version %s', (version) => {
    expect(supportsViteNodeVersion(version)).toBe(true)
    expect(nodePrerequisiteProblem(version)).toBeNull()
  })

  it.each([
    'v18.19.1',
    'v20.18.1',
    'v21.7.3',
    'v22.11.0',
    'v22.12.0-rc.1',
    'unknown',
  ])('rejects unsupported Node version %s', (version) => {
    expect(supportsViteNodeVersion(version)).toBe(false)
    expect(nodePrerequisiteProblem(version)).toEqual({
      what: `Node.js ${version} cannot run Vite (requires ${VITE_NODE_VERSION_RANGE}).`,
      fix: 'Upgrade to Node.js 22.12 or newer and make sure `node --version` reports the upgraded version.',
    })
  })

  it('reports a missing Node executable', () => {
    expect(nodePrerequisiteProblem(null)).toEqual({
      what: `Node.js not found (Vite requires ${VITE_NODE_VERSION_RANGE}).`,
      fix: 'Install Node.js 22.12 or newer and make sure `node` is on PATH.',
    })
  })
})
