import { describe, expect, it } from 'vitest'
import type { SheetAction } from './ActionSheet'
import { nativePickerSpec, nativeSheetEligible, nativeSheetSpec } from './action-sheet-native'

const noop = () => {}

describe('nativeSheetEligible', () => {
  it('accepts plain menus — hints, destructive and disabled rows included', () => {
    const actions: SheetAction[] = [
      { label: 'Open', onPress: noop },
      { label: 'Peek', hint: 'The task inspector, without leaving Work', onPress: noop },
      { label: 'Bring back', disabled: true, onPress: noop },
      { label: 'Delete…', destructive: true, onPress: noop },
    ]
    expect(nativeSheetEligible(actions)).toBe(true)
  })

  it('keeps toggle rows on the JS sheet — selected: false still marks a toggle', () => {
    const actions: SheetAction[] = [
      { label: 'P1', selected: false, onPress: noop },
      { label: 'P2', onPress: noop },
    ]
    expect(nativeSheetEligible(actions)).toBe(false)
  })

  it('keeps rows carrying meta or a glyph on the JS sheet', () => {
    expect(nativeSheetEligible([{ label: 'mac-mini', meta: '2d ago', onPress: noop }])).toBe(false)
    expect(nativeSheetEligible([{ label: 'Claude', icon: '◆', onPress: noop }])).toBe(false)
  })
})

describe('nativeSheetSpec', () => {
  it('maps actions to options 1:1 with Cancel appended last', () => {
    const spec = nativeSheetSpec({
      actions: [
        { label: 'Open', onPress: noop },
        { label: 'Rename', onPress: noop },
      ],
    })
    expect(spec.options).toEqual(['Open', 'Rename', 'Cancel'])
    expect(spec.cancelButtonIndex).toBe(2)
    expect(spec.title).toBeUndefined()
    expect(spec.message).toBeUndefined()
    expect(spec.destructiveButtonIndex).toBeUndefined()
    expect(spec.disabledButtonIndices).toBeUndefined()
  })

  it('carries the title as UIKit title and the subtitle as its message line', () => {
    const spec = nativeSheetSpec({
      title: 'Archive this task?',
      subtitle: 'This affects 3 tasks.',
      actions: [{ label: 'Archive', onPress: noop }],
    })
    expect(spec.title).toBe('Archive this task?')
    expect(spec.message).toBe('This affects 3 tasks.')
  })

  it('collects every destructive and disabled row by index', () => {
    const spec = nativeSheetSpec({
      actions: [
        { label: 'Open', onPress: noop },
        { label: 'Bring back', disabled: true, onPress: noop },
        { label: 'Archive…', destructive: true, onPress: noop },
        { label: 'Delete…', destructive: true, onPress: noop },
      ],
    })
    expect(spec.destructiveButtonIndex).toEqual([2, 3])
    expect(spec.disabledButtonIndices).toEqual([1])
  })
})

describe('nativePickerSpec', () => {
  it('flattens groups into prefixed rows and marks the current value', () => {
    const { spec, values } = nativePickerSpec({
      title: 'Model',
      groups: [
        { label: 'Claude', options: [{ value: 'claude:opus', label: 'Opus 5' }] },
        {
          label: 'Codex',
          options: [
            { value: 'codex:luna', label: 'GPT-5.6-Luna' },
            { value: 'codex:nova', label: 'GPT-5.6-Nova' },
          ],
        },
      ],
      selected: 'codex:luna',
    })
    expect(spec.options).toEqual([
      'Claude · Opus 5',
      '✓ Codex · GPT-5.6-Luna',
      'Codex · GPT-5.6-Nova',
      'Cancel',
    ])
    expect(spec.cancelButtonIndex).toBe(3)
    expect(values[1]).toBe('codex:luna')
  })

  it('leaves ungrouped rows bare', () => {
    const { spec } = nativePickerSpec({
      groups: [{ options: [{ value: 'low', label: 'Low' }] }],
      selected: undefined,
    })
    expect(spec.options).toEqual(['Low', 'Cancel'])
  })
})

describe('nativePickerSpec disabled rows', () => {
  it('maps unpickable rows to disabledButtonIndices', () => {
    const { spec } = nativePickerSpec({
      title: 'Machine',
      groups: [
        {
          options: [
            { value: 'm1', label: 'vps' },
            { value: 'm2', label: 'laptop — Offline', disabled: true },
          ],
        },
      ],
      selected: 'm1',
    })
    expect(spec.disabledButtonIndices).toEqual([1])
    expect(spec.options[0]).toBe('✓ vps')
  })
})
