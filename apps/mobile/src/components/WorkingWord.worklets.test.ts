import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

// Compile WorkingWord with the app's real worklets Babel plugin. Reanimated subscribes a
// useAnimatedStyle mapper only to shared values that sit directly in the updater's
// `__closure` (plain objects and arrays are walked, functions are not). A shared value
// read inside a called worklet is invisible, and the style never moves (POD-2626).
const require = createRequire(import.meta.url)
const plugin = require.resolve('react-native-worklets/plugin')
const babel = require(require.resolve('@babel/core', { paths: [plugin] })) as {
  transformSync(code: string, options: object): { code: string } | null
}
const typescript = require.resolve('@babel/preset-typescript', { paths: [plugin] })
const file = resolve(process.cwd(), 'src/components/WorkingWord.native.tsx')
const compiled =
  babel.transformSync(readFileSync(file, 'utf8'), {
    filename: file,
    babelrc: false,
    configFile: false,
    presets: [[typescript, { isTSX: true, allExtensions: true }]],
    plugins: [plugin],
  })?.code ?? ''

/** The captured names of every worklet handed straight to useAnimatedStyle. */
function animatedStyleClosures(code: string): string[][] {
  return code
    .split('useAnimatedStyle(')
    .slice(1)
    .map((call) => {
      const closure = /\.__closure = \{([^}]*)\}/.exec(call)?.[1] ?? ''
      return closure
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean)
    })
}

it('subscribes both glint styles to the shared clock and the measured width', () => {
  const closures = animatedStyleClosures(compiled)
  expect(closures).toHaveLength(2)
  for (const closure of closures) {
    expect(closure).toEqual(expect.arrayContaining(['workingWordProgress', 'width']))
  }
})

it('subscribes the View dot style directly to the shared mark clock', () => {
  const file = resolve(process.cwd(), 'src/components/WorkingMark.native.tsx')
  const code =
    babel.transformSync(readFileSync(file, 'utf8'), {
      filename: file,
      babelrc: false,
      configFile: false,
      presets: [[typescript, { isTSX: true, allExtensions: true }]],
      plugins: [plugin],
    })?.code ?? ''
  expect(animatedStyleClosures(code)).toEqual([expect.arrayContaining(['workingMarkProgress'])])
})
