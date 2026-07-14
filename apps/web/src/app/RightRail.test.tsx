import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RightRail } from './RightRail'

afterEach(cleanup)

describe('RightRail', () => {
  it('reopens the last panel, switches one panel at a time, and restores a closed superagent', () => {
    const onPanelChange = vi.fn()
    const onSuperModeChange = vi.fn()
    render(
      <RightRail
        rightPanel={null}
        lastPanel="git"
        superMode="closed"
        onPanelChange={onPanelChange}
        onSuperModeChange={onSuperModeChange}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Open last panel' }))
    expect(onPanelChange).toHaveBeenLastCalledWith('git')

    fireEvent.click(screen.getByRole('button', { name: 'Files' }))
    expect(onPanelChange).toHaveBeenLastCalledWith('files')

    fireEvent.click(screen.getByRole('button', { name: 'Open superagent' }))
    expect(onSuperModeChange).toHaveBeenLastCalledWith('open')
  })

  it('toggles the active panel closed', () => {
    const onPanelChange = vi.fn()
    render(
      <RightRail
        rightPanel="shell"
        lastPanel="shell"
        superMode="open"
        onPanelChange={onPanelChange}
        onSuperModeChange={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Shell' }))
    expect(onPanelChange).toHaveBeenCalledWith(null)
  })
})
