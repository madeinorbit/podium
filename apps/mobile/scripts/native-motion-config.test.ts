import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { expect, it } from 'vitest'

it('keeps the iOS synchronous-props build flag enabled without shared-element transitions', () => {
  const app = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'))
  const require = createRequire(import.meta.url)
  const dependency = dirname(require.resolve('react-native-reanimated/package.json'))
  const defaults = JSON.parse(
    readFileSync(resolve(dependency, 'src/featureFlags/staticFlags.json'), 'utf8'),
  )
  const overrides = app.reanimated?.staticFeatureFlags ?? {}
  expect(overrides.IOS_SYNCHRONOUSLY_UPDATE_UI_PROPS).toBe(true)
  expect({ ...defaults, ...overrides }.ENABLE_SHARED_ELEMENT_TRANSITIONS).toBe(false)
})
