import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

const swift = readFileSync(
  resolve(process.cwd(), 'modules/podium-list-row/ios/ContentVisibilityModifier.swift'),
  'utf8',
)
it('uses scroll intersection rather than prefetched appearance on current iOS, without polling', () => {
  expect(swift).toContain('if #available(iOS 18.0, *)')
  expect(swift).toContain('.onScrollVisibilityChange(threshold: 0.01, onChange)')
  expect(swift).not.toMatch(/Timer|CADisplayLink|TimelineView/)
  expect(swift).toContain('.onDisappear { onChange(false) }')
})
