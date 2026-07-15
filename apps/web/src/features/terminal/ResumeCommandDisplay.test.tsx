import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ResumeCommandDisplay } from './ResumeCommandDisplay'

describe('ResumeCommandDisplay', () => {
  it('renders the exact command as one whitespace-preserving text node', () => {
    const { container } = render(<ResumeCommandDisplay command="claude --resume conversation-id" />)
    const display = container.firstElementChild

    expect(display?.textContent).toBe('claude --resume conversation-id')
    expect(display?.childNodes).toHaveLength(1)
    expect(display?.classList.contains('whitespace-pre')).toBe(true)
  })
})
