/**
 * A swipe never commits an action by itself [POD-2527].
 *
 * SwiftUI's `swipeActions(allowsFullSwipe:)` and @expo/ui's
 * `SwipeActions.Actions` both default to a full swipe that performs the first
 * button. On the flight deck a fast page-back flick across a proposal row was
 * read as a full leading swipe and really started the proposal. Every swipe
 * action now goes through RevealSwipeActions, which only reveals buttons; this
 * test keeps it that way for every file in the app, present and future.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { expect, it, vi } from 'vitest'

const ROOT = resolve(import.meta.dirname, '..')
const SOURCE = /\.(tsx?|jsx?|swift)$/
const WRAPPER = 'src/components/RevealSwipeActions.ios.tsx'

vi.mock('@expo/ui/swift-ui', () => ({
  SwipeActions: {
    Actions: ({
      edge,
      allowsFullSwipe,
      children,
    }: {
      edge: string
      allowsFullSwipe?: boolean
      children: ReactNode
    }) => (
      <div data-testid={`swipe-${edge}`} data-full-swipe={String(allowsFullSwipe)}>
        {children}
      </div>
    ),
  },
}))

function* sources(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    if (entry.name === 'ios' && dir === ROOT) continue // prebuild output
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* sources(path)
    else if (SOURCE.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) yield path
  }
}

const files = ['src', 'app', 'modules']
  .flatMap((dir) => [...sources(join(ROOT, dir))])
  .map((path) => ({ path: relative(ROOT, path), text: readFileSync(path, 'utf8') }))

it('declares every row swipe action through the reveal-only wrapper', () => {
  const direct = files
    .filter(({ path }) => path !== WRAPPER)
    .filter(({ text }) => /SwipeActions\.Actions\b/.test(text))
    .map(({ path }) => path)
  expect(direct).toEqual([])
})

it('never enables a full swipe anywhere in the app', () => {
  const offenders = files.flatMap(({ path, text }) =>
    text
      .split('\n')
      .map((line, index) => ({ line: line.trim(), at: `${path}:${index + 1}` }))
      .filter(({ line }) => !line.startsWith('*') && !line.startsWith('//'))
      .filter(
        ({ line }) =>
          // Any allowsFullSwipe other than the literal false, a bare SwiftUI
          // .swipeActions (whose default is a full swipe), or a UIKit
          // configuration that performs its first action on a full swipe.
          (/allowsFullSwipe/.test(line) && !/allowsFullSwipe(=\{|: ?)false\b/.test(line)) ||
          (/\.swipeActions\(/.test(line) && !/allowsFullSwipe: ?false/.test(line)) ||
          /performsFirstActionWithFullSwipe\s*=\s*true/.test(line),
      )
      .map(({ at }) => at),
  )
  expect(offenders).toEqual([])
})

it('reveals swipe buttons on either edge without a full swipe', async () => {
  const { RevealSwipeActions } = await import('./components/RevealSwipeActions.ios')
  const view = render(
    <>
      <RevealSwipeActions edge="leading">
        <button type="button">Lead</button>
      </RevealSwipeActions>
      <RevealSwipeActions edge="trailing">
        <button type="button">Trail</button>
      </RevealSwipeActions>
    </>,
  )
  expect(view.getByTestId('swipe-leading').dataset.fullSwipe).toBe('false')
  expect(view.getByTestId('swipe-trailing').dataset.fullSwipe).toBe('false')
})

it('keeps the Work, Tasks and flight deck rows on the wrapper', () => {
  for (const path of [
    'src/screens/WorkSurface.ios.tsx',
    'src/screens/TasksSurface.ios.tsx',
    'src/components/MissionProposalRow.ios.tsx',
  ]) {
    expect(files.find((file) => file.path === path)?.text, path).toMatch(/<RevealSwipeActions\b/)
  }
})

it('lets the Screen proposed card swipe only skip, never start or decline', () => {
  const card = files.find(({ path }) => path === 'src/components/ScreeningCard.tsx')?.text ?? ''
  expect(card).toMatch(/scheduleOnRN\(onSkip\)/)
  expect(card).not.toMatch(/'accepted'|'declined'/)
})
