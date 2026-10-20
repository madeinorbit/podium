import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const css = readFileSync('src/styles.css', 'utf8')
const section = css.split('/* Full alone sheds')[1]!
const full = section.slice(section.indexOf('*/') + 2)
const base = full.split('@container flight-full')[0]!
const queries = [
  ...css.matchAll(/@container flight-full \(width (<|>=) (\d+)px\) \{([\s\S]*?)\n\}/g),
]

// This is a source contract, not a layout engine: evaluate only the named
// panel-width rungs and their exact selectors/declarations. happy-dom does not
// lay out container queries; the attached HTML uses the actual source CSS.
function declaration(width: number, selector: string, property: string): string | undefined {
  const active = queries.filter((q) =>
    q[1] === '<' ? width < Number(q[2]) : width >= Number(q[2]),
  )
  let value: string | undefined
  for (const rule of [base, ...active.map((q) => q[3]!)]
    .join('\n')
    .matchAll(/([^{}]+)\{([^{}]+)\}/g)) {
    if (
      !rule[1]!
        .split(',')
        .map((s) => s.trim())
        .includes(selector)
    )
      continue
    for (const part of rule[2]!.split(';')) {
      const [key, ...rest] = part.split(':')
      if (key?.trim() === property) value = rest.join(':').trim()
    }
  }
  return value
}

it.each([
  300, 320, 359, 360, 439, 440, 480, 559, 560, 859, 860, 900, 1120,
])('Full sheds optional slots in order at panel width %i', (width) => {
  expect(declaration(width, ".flight-v6-dependency[data-kind='waiting']", 'display')).toBe(
    width >= 860 ? 'inline-flex' : 'none',
  )
  expect(declaration(width, '.flight-v6-role', 'display')).toBe(width < 560 ? 'none' : undefined)
  expect(
    declaration(
      width,
      ".flight-v6-dependency[data-kind='blocked'] .flight-v6-dependency-label",
      'display',
    ),
  ).toBe(width < 560 ? 'none' : undefined)
  expect(
    declaration(
      width,
      ".flight-v6-dependency[data-kind='blocked'] .flight-v6-dependency-ref",
      'display',
    ),
  ).toBe(width < 440 ? 'none' : undefined)
  for (const selector of ['.flight-v6-counter', '.flight-v6-engines'])
    expect(declaration(width, selector, 'display')).toBe(width < 360 ? 'none' : undefined)
  expect(declaration(width, '.flight-v6-rows', '--v6-state-width')).toBe(
    width < 360 ? '56px' : '76px',
  )
  expect(declaration(width, '.flight-v6-rows', '--v6-gap')).toBe(width < 360 ? '6px' : undefined)
  expect(declaration(width, '.flight-v6-rows', '--v6-title-min')).toBe(
    width < 360 ? '40px' : undefined,
  )
  for (const selector of [
    '.flight-v6-ref',
    '.flight-v6-fold',
    '.flight-v6-ring-control',
    '.flight-v6-state',
    '.flight-v6-dependency',
  ])
    expect(declaration(width, selector, 'display')).not.toBe('none')
})

it('keeps intrinsic identity/state, title minima and the edge gutter through wrapped rows', () => {
  expect(declaration(300, '.flight-full-panel', 'container')).toBe('flight-full / inline-size')
  expect(declaration(300, '.flight-v6-strip', 'container-type')).toBe('normal')
  expect(declaration(300, '.flight-v6-strip', 'padding')).toBe('3px 6px')
  expect(declaration(300, '.flight-v6-strip', 'height')).toBe('auto')
  expect(declaration(300, '.flight-v6-task-body', 'flex-wrap')).toBe('wrap')
  expect(declaration(300, '.flight-v6-ref', 'overflow-wrap')).toBe('anywhere')
  expect(declaration(300, '.flight-v6-state', 'min-width')).toBe('max-content')
  expect(declaration(300, '.flight-v6-title', 'min-width')).toBe('var(--v6-title-min, 60px)')
  expect(full).toContain('--v6-indent-limit: clamp(0px, calc(100cqi - 440px), 66px)')
  expect(full).toContain(
    '.flight-full-phase-content { position: relative; margin-left: 0; padding-left: 0; border-left: 0; }',
  )
  expect(declaration(300, '.flight-full-phase-hairline', 'min-width')).toBe('0')
  expect(declaration(300, '.flight-full-phase-toggle', 'flex-wrap')).toBe('wrap')
  expect(declaration(300, '.flight-proposal-actions button', 'flex')).toBe('none')
  expect(full).not.toContain('@media')
  expect(css).toContain('container: gauge-band / inline-size')
  expect(css).toContain('.flight-full-gauge-row > :is(button, [data-testid="mission-cost-chip"])')
})
