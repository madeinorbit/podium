import { describe, expect, it } from 'vitest'
import {
  ACCEPTED_DUPLICATE_PACKAGES,
  type DuplicateAcceptance,
  duplicateReport,
} from './web-bundle-duplicates'

/**
 * PROOF THAT THE GATE CAN SAY NO.
 *
 * The only test this check had asserted that the build script joins it with
 * `&&` — that it is WIRED, not that it WORKS. The one demonstration that it can
 * go red was a build in a sibling worktree, and a worktree is deleted when its
 * issue closes; POD-2530 was filed because the repository was left holding no
 * durable evidence that this gate refuses anything. That is the same defect
 * class the gate itself exists to catch.
 *
 * So these cases run the detection over synthetic ABSOLUTE source paths — the
 * shape a chunk map yields after `resolve()` — and every one of them goes red if
 * the duplicate detection is removed.
 */

const worktree = '/home/mgw/src/other/podium/.worktrees/issue-2504/node_modules'
const main = '/home/mgw/src/other/podium/node_modules'

describe('a package bundled from more than one installation', () => {
  it('names the package and both directories', () => {
    // The measured failure of POD-2527, in miniature: `.worktrees/` sits inside
    // the main checkout, so a worktree with no apps/web/node_modules walks up
    // past its own root and resolves the second copy in the main one.
    const report = duplicateReport([
      `${worktree}/@dnd-kit/core/dist/core.esm.js`,
      `${main}/@dnd-kit/core/dist/core.esm.js`,
    ])

    expect(report.duplicated).toHaveLength(1)
    expect(report.duplicated[0]?.package).toBe('@dnd-kit/core')
    expect(report.duplicated[0]?.installations).toEqual([
      `${worktree}/@dnd-kit/core`,
      `${main}/@dnd-kit/core`,
    ])
    expect(report.duplicated[0]?.breaksTheFeature).toBe(false)
  })

  it('says nothing about a package installed once, however many files it lands', () => {
    const report = duplicateReport([
      `${main}/@dnd-kit/core/dist/core.esm.js`,
      `${main}/@dnd-kit/core/dist/utilities.esm.js`,
      `${main}/clsx/dist/clsx.mjs`,
      '/home/mgw/src/other/podium/apps/web/src/main.tsx',
    ])

    expect(report.duplicated).toEqual([])
    expect(report.accepted).toEqual([])
  })

  it('reads the .bun store spelling as the same package as the hoisted copy', () => {
    // The pair that actually splits inside ONE checkout: apps/web/node_modules
    // symlinks some specifiers into node_modules/.bun and not others, so the
    // name has to come from the LAST node_modules segment or these two read as
    // different packages and the split goes unseen.
    const report = duplicateReport([
      `${main}/.bun/@codemirror+state@6.5.2/node_modules/@codemirror/state/dist/index.js`,
      `${main}/@codemirror/state/dist/index.js`,
    ])

    expect(report.duplicated.map((entry) => entry.package)).toEqual(['@codemirror/state'])
  })

  it('marks a split that BREAKS the feature rather than costing bytes', () => {
    // POD-2469: two @codemirror/state copies mean EditorState.create meets a
    // Facet minted by the other one and throws.
    const report = duplicateReport([
      `${worktree}/@codemirror/state/dist/index.js`,
      `${main}/@codemirror/state/dist/index.js`,
      `${worktree}/clsx/dist/clsx.mjs`,
      `${main}/clsx/dist/clsx.mjs`,
    ])

    expect(report.duplicated.map((entry) => [entry.package, entry.breaksTheFeature])).toEqual([
      ['@codemirror/state', true],
      ['clsx', false],
    ])
  })

  it('counts a scoped package by scope AND name, not by scope alone', () => {
    // @dnd-kit/core and @dnd-kit/utilities are two packages, each installed once.
    const report = duplicateReport([
      `${main}/@dnd-kit/core/dist/core.esm.js`,
      `${main}/@dnd-kit/utilities/dist/utilities.esm.js`,
    ])

    expect(report.duplicated).toEqual([])
  })
})

describe('the accept list', () => {
  const acceptance: DuplicateAcceptance = {
    package: '@trpc/client',
    installations: 2,
    reason: 'test fixture, not a real acceptance',
  }

  it('lets a signed-off split through instead of failing the release', () => {
    // Without this the check can only ever advise dedupe, which is the WRONG
    // advice for a two-version install somebody chose on purpose.
    const report = duplicateReport(
      [
        `${main}/@trpc/client/dist/index.mjs`,
        `${main}/.bun/@trpc+client@10/node_modules/@trpc/client/dist/index.mjs`,
      ],
      [acceptance],
    )

    expect(report.duplicated).toEqual([])
    expect(report.accepted.map((entry) => entry.package)).toEqual(['@trpc/client'])
    expect(report.accepted[0]?.reason).toBe(acceptance.reason)
    expect(report.unusedAcceptances).toEqual([])
  })

  it('still fails when a THIRD copy arrives behind the old decision', () => {
    // An acceptance covers the number of installations that were measured. A
    // split that grows past it is not the split anyone signed off.
    const report = duplicateReport(
      [
        `${main}/@trpc/client/dist/index.mjs`,
        `${main}/.bun/@trpc+client@10/node_modules/@trpc/client/dist/index.mjs`,
        `${worktree}/@trpc/client/dist/index.mjs`,
      ],
      [acceptance],
    )

    expect(report.duplicated.map((entry) => entry.package)).toEqual(['@trpc/client'])
    expect(report.duplicated[0]?.acceptedInstallations).toBe(2)
    expect(report.accepted).toEqual([])
  })

  it('fails on an entry that no longer describes anything in the bundle', () => {
    // The hatch has to be as easy to close as to open: an acceptance whose
    // reason has expired is an open door nobody remembers holding.
    const report = duplicateReport([`${main}/@trpc/client/dist/index.mjs`], [acceptance])

    expect(report.duplicated).toEqual([])
    expect(report.unusedAcceptances).toEqual(['@trpc/client'])
  })

  it('refuses to honour an entry naming a package a split BREAKS', () => {
    const report = duplicateReport(
      [`${worktree}/react/index.js`, `${main}/react/index.js`],
      [{ package: 'react', installations: 2, reason: 'never legitimate' }],
    )

    expect(report.illegalAcceptances).toEqual(['react'])
    expect(report.duplicated.map((entry) => entry.package)).toEqual(['react'])
    expect(report.duplicated[0]?.breaksTheFeature).toBe(true)
    expect(report.accepted).toEqual([])
  })

  it('is empty, and every future entry has to be argued for here', () => {
    // Deliberately a test rather than a comment: adding an entry means editing
    // this line, and the diff that does it is where the justification is read.
    // The store already carries multi-version installs (@trpc/client,
    // @tanstack/db, @testing-library/react) — none of them reaches the browser
    // bundle from two places today.
    expect(ACCEPTED_DUPLICATE_PACKAGES).toEqual([])
  })
})
