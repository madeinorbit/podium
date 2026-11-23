import { describe, expect, it } from 'vitest'
import { splitSingletons } from './web-bundle-duplicates'

/**
 * PROOF THAT THE CHECK CAN SAY NO (POD-2530).
 *
 * These cases run the detection over synthetic ABSOLUTE source paths, the shape
 * a chunk map yields after `resolve()`, so the check's ability to refuse is
 * proven without a built website.
 */

const worktree = '/home/mgw/src/other/podium/.worktrees/issue-2504/node_modules'
const main = '/home/mgw/src/other/podium/node_modules'

describe('a singleton package bundled from more than one installation', () => {
  it('names the package and both directories', () => {
    // POD-2469: two @codemirror/state copies mean EditorState.create meets a
    // Facet minted by the other one and throws. `.worktrees/` sits inside the
    // main checkout, so a worktree with no apps/web/node_modules walks up past
    // its own root and resolves the second copy in the main one.
    expect(
      splitSingletons([
        `${worktree}/@codemirror/state/dist/index.js`,
        `${main}/@codemirror/state/dist/index.js`,
      ]),
    ).toEqual([
      {
        package: '@codemirror/state',
        installations: [`${worktree}/@codemirror/state`, `${main}/@codemirror/state`],
      },
    ])
  })

  it('says nothing about a singleton installed once, however many files it lands', () => {
    expect(
      splitSingletons([
        `${main}/@codemirror/state/dist/index.js`,
        `${main}/@codemirror/state/dist/facet.js`,
        '/home/mgw/src/other/podium/apps/web/src/main.tsx',
      ]),
    ).toEqual([])
  })

  it('reads the .bun store spelling as the same package as the hoisted copy', () => {
    // The pair that actually splits inside ONE checkout: apps/web/node_modules
    // symlinks some specifiers into node_modules/.bun and not others.
    expect(
      splitSingletons([
        `${main}/.bun/@codemirror+state@6.5.2/node_modules/@codemirror/state/dist/index.js`,
        `${main}/@codemirror/state/dist/index.js`,
      ]).map((entry) => entry.package),
    ).toEqual(['@codemirror/state'])
  })

  it('ignores a split of a package a second copy only costs bytes for', () => {
    // The build sets no size limits (POD-6423): a split clsx breaks nothing.
    expect(
      splitSingletons([`${worktree}/clsx/dist/clsx.mjs`, `${main}/clsx/dist/clsx.mjs`]),
    ).toEqual([])
  })

  it('does not read a package whose name extends a singleton as that singleton', () => {
    expect(
      splitSingletons([
        `${main}/react/index.js`,
        `${worktree}/react-dom/index.js`,
        `${main}/react-dom/index.js`,
      ]).map((entry) => entry.package),
    ).toEqual(['react-dom'])
  })
})
