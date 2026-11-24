import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ComposeMenuProps } from './ComposeMenu'

const native = vi.hoisted(() => ({ props: undefined as ComposeMenuProps | undefined }))
vi.mock('./ComposeMenu', () => ({
  ComposeMenu: (props: ComposeMenuProps) => {
    native.props = props
    return null
  },
}))
const { ComposeStartButton } = await import('./ComposeStartButton')
afterEach(cleanup)

it.each([
  false,
  true,
])('guards the primary Send action with canStart=%s while keeping Save available', (canStart) => {
  const start = vi.fn()
  const save = vi.fn()
  render(
    <ComposeStartButton
      hasPrompt={false}
      busy={false}
      canStart={canStart}
      canSave
      onCancel={vi.fn()}
      onStart={start}
      onSave={save}
    />,
  )
  native.props?.onPrimaryAction?.()
  expect(start).toHaveBeenCalledTimes(canStart ? 1 : 0)
  const saveItem = native.props?.items.find((item) => item.id === 'save')
  expect(saveItem?.disabled).toBe(false)
  saveItem?.onPress?.()
  expect(save).toHaveBeenCalledOnce()
})
