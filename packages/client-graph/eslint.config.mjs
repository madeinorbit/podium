/**
 * ESLint flat config for the product MobX worklist pool (POD-4447 done criteria):
 * `eslint-plugin-mobx` `missing-observer` (components reading observables
 * must be `observer`) and `exhaustive-make-observable` (every model member
 * annotated in `makeObservable`).
 *
 * The parser is Babel's, not typescript-eslint's: typescript-eslint refuses
 * the repository's TypeScript 7 compiler, and neither mobx rule needs type
 * information — both are syntactic.
 *
 * Run from `packages/client-graph`: `bun run lint`.
 */

import { fenceConfig } from '../worklist-proto/harness/lint/fence-plugin.mjs'
import babelParser from '@babel/eslint-parser'
import mobx from 'eslint-plugin-mobx'
import { createRequire } from 'node:module'

// Resolved from this package, not by bare name: Babel resolves a bare plugin
// name from its own install location, which Bun's isolated linker does not
// give this package's devDependencies (it only worked where the shared store
// happened to link the plugin nearby).
const BABEL_SYNTAX_TS = createRequire(import.meta.url).resolve('@babel/plugin-syntax-typescript')


export default [
  ...fenceConfig({ root: 'src', frozen: ['shared'] }).map((config) => ({
    ...config, ignores: [...(config.ignores ?? []), 'src/shared/**'],
  })),
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: babelParser,
      parserOptions: {
        requireConfigFile: false,
        babelOptions: {
          configFile: false,
          babelrc: false,
          plugins: [[BABEL_SYNTAX_TS, { isTSX: true, allExtensions: true }]],
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
  {
    // POD-4565: the pool's row components take a plain `RowView` (L1b) and
    // read no observable, so an `observer` would observe nothing and trip
    // MobX's `reactionRequiresObservable` (enforced as an error in the pool's
    // tests). Their slots (`pool/react/list.tsx`, `pool/native/list.tsx`) are
    // the observers. These two files hold nothing else.
    files: ['**/pool/react/row.tsx', '**/pool/native/row.tsx'],
    rules: { 'mobx/missing-observer': 'off' },
  },
  {
    // POD-4568 (M3 F2): the row views resolve every relation through the
    // engine (`inputs.relations`), never themselves. They may not import the
    // relation module (its `relationRef` is the engine's and the scan's).
    files: ['**/views.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['./relations', './relations.ts'],
              message: 'Resolve relations through inputs.relations (one/many), not relations.ts.',
            },
          ],
        },
      ],
    },
  },
]
