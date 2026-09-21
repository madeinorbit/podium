/**
 * Folder-local ESLint flat config for the MobX arm (POD-4447 done criteria):
 * `eslint-plugin-mobx` `missing-observer` (components reading observables
 * must be `observer`) and `exhaustive-make-observable` (every model member
 * annotated in `makeObservable`).
 *
 * Run from `packages/worklist-proto`:
 *   bunx eslint --config arms/mobx/eslint.config.mjs arms/mobx
 */

import mobx from 'eslint-plugin-mobx'

export default [
  {
    files: ['**/*.ts', '**/*.tsx'],
    plugins: { mobx },
    rules: {
      'mobx/missing-observer': 'error',
      'mobx/exhaustive-make-observable': 'error',
    },
  },
]
