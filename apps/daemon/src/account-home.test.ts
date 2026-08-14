import { describe, expect, it } from 'vitest'
import { provisionedAccountHome } from './account-home'

describe('provisioned native account HOME', () => {
  it('rejects a configured path that aliases ambient HOME through a symlink', () => {
    const aliases = new Map([
      ['/configured/account-home', '/real/operator-home'],
      ['/ambient/home', '/real/operator-home'],
    ])
    expect(
      provisionedAccountHome({
        path: '/configured/account-home',
        source: 'configured',
        ambientHome: '/ambient/home',
        realpath: (path) => aliases.get(path) ?? path,
      }),
    ).toBeUndefined()
  })

  it('retains canonical provisioned-root provenance when roots are distinct', () => {
    const aliases = new Map([
      ['/configured/account-home', '/real/account-home'],
      ['/ambient/home', '/real/operator-home'],
    ])
    expect(
      provisionedAccountHome({
        path: '/configured/account-home',
        source: 'configured',
        ambientHome: '/ambient/home',
        realpath: (path) => aliases.get(path) ?? path,
      }),
    ).toEqual({ path: '/real/account-home', source: 'configured' })
  })
})
