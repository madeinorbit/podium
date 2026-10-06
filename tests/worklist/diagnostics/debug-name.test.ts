import { afterEach, describe, expect, it, vi } from 'vitest'

async function names(options: { dev?: boolean; mode?: string; search?: string } = {}) {
  vi.resetModules()
  vi.stubEnv('DEV', options.dev ?? false)
  vi.stubEnv('MODE', options.mode ?? 'production')
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubGlobal('location', { search: options.search ?? '' })
  return import('@podium/client-graph/debug-name')
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('pool diagnostic names', () => {
  it('does not build a production name', async () => {
    const { debugName } = await names()
    const make = vi.fn(() => { throw new Error('A production name was interpolated') })
    expect(debugName(make)).toBeUndefined()
    expect(make).not.toHaveBeenCalled()
  })

  it.each([
    { dev: true, mode: 'development' },
    { dev: false, mode: 'test' },
  ])('keeps names in $mode builds', async (options) => {
    const { debugName } = await names(options)
    expect(debugName(() => 'IssueModel@I1.facts')).toBe('IssueModel@I1.facts')
  })

  it.each(['?mobxSidebarCheck=1'])('keeps production names with %s', async (search) => {
    const { debugName } = await names({ search })
    expect(debugName(() => 'pool.file.I1')).toBe('pool.file.I1')
  })

  it.each(['?mobxSidebarCheck=0', '?mobxSidebar=1'])('omits names with %s', async (search) => {
    const { debugName } = await names({ search })
    expect(debugName(() => 'pool.file.I1')).toBeUndefined()
  })

  it('reads diagnostic flags once at startup', async () => {
    const { debugName } = await names()
    vi.stubGlobal('location', { search: '?mobxSidebarCheck=1' })
    expect(debugName(() => 'pool.file.I1')).toBeUndefined()
  })

  it('lets memory tools opt in before constructing the pool', async () => {
    const { debugName, enableDebugNames } = await names()
    enableDebugNames()
    expect(debugName(() => 'pool.issue')).toBe('pool.issue')
  })

})
