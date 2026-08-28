import { describe, expect, it } from 'vitest'
// CommonJS because `expo prebuild` requires the plugin directly, outside this
// repo's TypeScript pipeline.
import plugin from './with-sqlite-header-link.js'

const { addSqliteHeaderLink } = plugin as unknown as {
  addSqliteHeaderLink: (podfile: string) => string
}

// A trimmed copy of the block `expo prebuild` generates.
const PODFILE = `target 'PodiumMobile' do
  use_expo_modules!

  post_install do |installer|
    react_native_post_install(
      installer,
      config[:reactNativePath],
    )
  end
end
`

describe('addSqliteHeaderLink', () => {
  it('links the header from inside post_install, where the sandbox exists', () => {
    const patched = addSqliteHeaderLink(PODFILE)

    const hook = patched.indexOf("Headers', 'Public', 'ExpoSQLite'")
    expect(hook).toBeGreaterThan(patched.indexOf('post_install do |installer|'))
    expect(hook).toBeLessThan(patched.indexOf('\n  end\nend'))
    expect(patched).toContain('expo-sqlite/package.json')
  })

  it('stays a single copy when prebuild runs over an existing ios directory', () => {
    const once = addSqliteHeaderLink(PODFILE)
    expect(addSqliteHeaderLink(once)).toBe(once)
  })

  it('refuses a Podfile it cannot anchor to, rather than dropping the fix', () => {
    expect(() => addSqliteHeaderLink("target 'PodiumMobile' do\nend\n")).toThrow(/post_install/)
  })
})
