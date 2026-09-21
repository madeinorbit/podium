/**
 * Folder-local ESLint flat config for the MobX arm (POD-4447 done criteria):
 * `eslint-plugin-mobx` `missing-observer` (components reading observables
 * must be `observer`) and `exhaustive-make-observable` (every model member
 * annotated in `makeObservable`).
 *
 * The parser is Babel's, not typescript-eslint's: typescript-eslint refuses
 * the repository's TypeScript 7 compiler, and neither mobx rule needs type
 * information — both are syntactic.
 *
 * Run from `packages/worklist-proto`:
 *   bunx eslint --config arms/mobx/eslint.config.mjs arms/mobx
 */

import babelParser from '@babel/eslint-parser'
import mobx from 'eslint-plugin-mobx'

export default [
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: babelParser,
      parserOptions: {
        requireConfigFile: false,
        babelOptions: {
          configFile: false,
          babelrc: false,
          plugins: [['@babel/plugin-syntax-typescript', { isTSX: true, allExtensions: true }]],
        },
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: { mobx },
    rules: {
      'mobx/missing-observer': 'error',
      'mobx/exhaustive-make-observable': 'error',
    },
  },
]
