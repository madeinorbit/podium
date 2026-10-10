const path = require('node:path')

// Standard (2022.3) decorators, as TypeScript, Bun and the Vite builds
// (scripts/vite-standard-decorators.ts) compile them. babel-preset-expo defaults
// to legacy ones, which @podium/mobx-helpers' `@lazy` refuses. The preset is the
// one Expo uses when no config exists, resolved through `expo` because the
// isolated install does not link it into this app.
const expoDir = path.dirname(require.resolve('expo/package.json'))
const preset = require.resolve('babel-preset-expo', { paths: [expoDir] })
// Type-only `declare` class fields (shared client-graph models narrow `id`) must
// be stripped by the TypeScript transform before the preset's Flow pass sees them.
const typescript = require.resolve('@babel/plugin-transform-typescript', {
  paths: [path.dirname(preset)],
})

module.exports = (api) => {
  api.cache(true)
  return {
    overrides: [
      {
        test: (file) => typeof file === 'string' && file.endsWith('.ts'),
        plugins: [[typescript, { allowDeclareFields: true }]],
      },
      {
        test: (file) => typeof file === 'string' && file.endsWith('.tsx'),
        plugins: [[typescript, { allowDeclareFields: true, isTSX: true }]],
      },
    ],
    presets: [[preset, { decorators: { version: '2023-11' } }]],
  }
}
