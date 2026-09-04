import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { render } from '@testing-library/react'
import { Pressable, View } from 'react-native'
import {
  createSourceFile,
  forEachChild,
  isJsxAttribute,
  isJsxOpeningLikeElement,
  isObjectLiteralExpression,
  type JsxOpeningLikeElement,
  type Node,
  ScriptKind,
  ScriptTarget,
  type SourceFile,
} from 'typescript'
import { describe, expect, it, vi } from 'vitest'

vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light' },
  impactAsync: vi.fn(() => Promise.resolve()),
}))

const { PressableScale } = await import('../components/PressableScale')

/**
 * THE STATE A CONTROL DECLARES HAS TO REACH THE BROWSER.
 *
 * react-native-web 0.21 stopped mapping React Native's `accessibilityState`
 * onto ARIA and reads the `aria-*` props directly. Nothing failed at the
 * upgrade — every `accessibilityState` in the app simply stopped rendering, and
 * a screen reader on the web build heard a plain button with no busy, selected
 * or expanded state. It went unnoticed because nothing in this lane had ever
 * asserted a rendered attribute. [POD-1664]
 *
 * So there are two guards here, and they fail for different reasons:
 *
 *   `renders the state` pins the renderer. It is the one that catches
 *     react-native-web changing its mind again, in either direction.
 *
 *   `every control` walks the app's own source. It is the one that catches a
 *     control ADDED LATER with only the React Native spelling — the case that
 *     produced this bug and that no amount of rendered assertions on today's
 *     components would have caught.
 */

/**
 * What each `accessibilityState` key needs beside it for the browser to see it.
 *
 * `selected` accepts either spelling because the right one depends on the role.
 * `aria-selected` is only meaningful on a tab/option/grid role; on a `button` it
 * is ignored, and the browser-visible way to mark the chosen one of a group of
 * buttons is `aria-pressed`.
 *
 * `disabled` also accepts the plain `disabled` prop, which is not a shortcut:
 * react-native-web still renders it as a real disabled control AND emits
 * `aria-disabled`, so a second attribute beside it would be noise. That is a
 * claim about the renderer, so `renders the state` below pins it.
 */
const COUNTERPART: Record<string, readonly string[]> = {
  busy: ['aria-busy'],
  checked: ['aria-checked'],
  disabled: ['aria-disabled', 'disabled'],
  expanded: ['aria-expanded'],
  selected: ['aria-selected', 'aria-pressed'],
}

const sourceRoot = resolve(import.meta.dirname, '..')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(path))
    else if (entry.name.endsWith('.tsx') && !entry.name.includes('.test.')) out.push(path)
  }
  return out
}

/** Every key named in an `accessibilityState` value, including both arms of a conditional. */
function stateKeys(attribute: Node): string[] {
  const keys: string[] = []
  const visit = (node: Node) => {
    if (isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        const name = property.name?.getText()
        if (name) keys.push(name.replace(/^['"]|['"]$/g, ''))
      }
    }
    forEachChild(node, visit)
  }
  visit(attribute)
  return keys
}

function attributeNames(element: JsxOpeningLikeElement): Set<string> {
  const names = new Set<string>()
  for (const attribute of element.attributes.properties) {
    if (isJsxAttribute(attribute)) names.add(attribute.name.getText())
  }
  return names
}

type Gap = { where: string; key: string; wanted: readonly string[] }

function gaps(file: SourceFile, path: string): { gaps: Gap[]; checked: number } {
  const found: Gap[] = []
  let checked = 0
  const visit = (node: Node) => {
    if (isJsxOpeningLikeElement(node)) {
      const names = attributeNames(node)
      if (names.has('accessibilityState')) {
        const attribute = node.attributes.properties.find(
          (property) =>
            isJsxAttribute(property) && property.name.getText() === 'accessibilityState',
        )
        if (attribute) {
          checked += 1
          const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1
          const where = `${relative(sourceRoot, path)}:${line}`
          for (const key of stateKeys(attribute)) {
            const wanted = COUNTERPART[key]
            // An unmapped key is a gap too: a new state nobody taught this test
            // about would otherwise pass by being unrecognised.
            if (!wanted) found.push({ where, key, wanted: ['a counterpart in COUNTERPART'] })
            else if (!wanted.some((name) => names.has(name))) found.push({ where, key, wanted })
          }
        }
      }
    }
    forEachChild(node, visit)
  }
  visit(file)
  return { gaps: found, checked }
}

describe('accessibility state on web', () => {
  it('renders the state react-native-web actually reads', () => {
    const { container } = render(
      <>
        <View testID="rn-spelling" accessibilityState={{ busy: true, expanded: true }} />
        <View testID="aria-busy" aria-busy={true} />
        <View testID="aria-expanded" aria-expanded={true} />
        <View testID="aria-selected" aria-selected={true} />
        <Pressable testID="aria-pressed" accessibilityRole="button" aria-pressed={true} />
        <PressableScale testID="disabled-prop" accessibilityRole="button" disabled />
      </>,
    )
    const at = (id: string) => container.querySelector(`[data-testid="${id}"]`)

    // THE BUG ITSELF. If this ever fails, react-native-web has started reading
    // `accessibilityState` again — at which point the second spelling across the
    // app is redundant rather than load-bearing, and COUNTERPART can go.
    expect(at('rn-spelling')?.getAttribute('aria-busy')).toBeNull()
    expect(at('rn-spelling')?.getAttribute('aria-expanded')).toBeNull()

    expect(at('aria-busy')?.getAttribute('aria-busy')).toBe('true')
    expect(at('aria-expanded')?.getAttribute('aria-expanded')).toBe('true')
    expect(at('aria-selected')?.getAttribute('aria-selected')).toBe('true')
    expect(at('aria-pressed')?.getAttribute('aria-pressed')).toBe('true')

    // Why COUNTERPART.disabled accepts the plain prop: it arrives as ARIA on its
    // own, through PressableScale, which is what the app's call sites use.
    expect(at('disabled-prop')?.getAttribute('aria-disabled')).toBe('true')
  })

  it('every control that declares state also spells it for the browser', () => {
    const files = sourceFiles(sourceRoot)
    const found: Gap[] = []
    let checked = 0
    for (const path of files) {
      const text = readFileSync(path, 'utf8')
      if (!text.includes('accessibilityState')) continue
      const file = createSourceFile(path, text, ScriptTarget.Latest, true, ScriptKind.TSX)
      const result = gaps(file, path)
      found.push(...result.gaps)
      checked += result.checked
    }

    // A walker that silently stops finding elements would pass this test while
    // asserting nothing. The app has ~35 of these; the floor only has to be
    // high enough that a broken walk cannot clear it.
    expect(checked).toBeGreaterThan(25)

    expect(
      found.map(({ where, key, wanted }) => `${where} — '${key}' needs ${wanted.join(' or ')}`),
    ).toEqual([])
  })
})
