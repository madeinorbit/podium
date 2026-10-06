const path = require('node:path')

// Standard (2022.3) decorators, as TypeScript, Bun and the Vite builds
// (scripts/vite-standard-decorators.ts) compile them. babel-preset-expo defaults
// to legacy ones, which @podium/mobx-helpers' `@lazy` refuses. The preset is the
// one Expo uses when no config exists, resolved through `expo` because the
// isolated install does not link it into this app.
const preset = require.resolve('babel-preset-expo', {
  paths: [path.dirname(require.resolve('expo/package.json'))],
})

module.exports = (api) => {
  api.cache(true)
  return { presets: [[preset, { decorators: { version: '2023-11' } }]] }
}
