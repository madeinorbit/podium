import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ResumeCommandDisplay } from './ResumeCommandDisplay'

describe('ResumeCommandDisplay', () => {
  it('renders a fixed-width non-breaking separator after the executable', () => {
    const { container } = render(<ResumeCommandDisplay command="claude --resume conversation-id" />)

    expect(container.textContent).toBe('claude\u00a0--resume conversation-id')
    expect(container.querySelector('.w-\\[1ch\\]')).not.toBeNull()
  })
})
