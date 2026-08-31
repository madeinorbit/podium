import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToggleRow } from './TaskFiltersSheet'

afterEach(cleanup)

describe('TaskFiltersSheet toggles', () => {
  it('gives the native switch its visible label and hint', () => {
    const onChange = vi.fn()
    render(
      <ToggleRow
        label="Agent tasks"
        hint="Show internal work at the top level"
        value={false}
        onChange={onChange}
      />,
    )

    const toggle = screen.getByLabelText('Agent tasks')
    expect(toggle.getAttribute('aria-label')).toBe('Agent tasks')
    fireEvent.click(toggle)
    expect(onChange).toHaveBeenCalledWith(true)
  })
})
