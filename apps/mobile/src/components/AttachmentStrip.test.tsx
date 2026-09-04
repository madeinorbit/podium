import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AttachmentStrip } from './AttachmentStrip'

afterEach(cleanup)

describe('AttachmentStrip accessibility', () => {
  it('keeps a failed-file error and its Remove button as separate accessible controls', () => {
    const onRemove = vi.fn()
    render(
      <AttachmentStrip
        attachments={[
          {
            id: 'failed-file',
            name: 'report.pdf',
            previewUri: '',
            state: 'failed',
            error: 'report.pdf is larger than 7.5 MB.',
          },
        ]}
        onRemove={onRemove}
      />,
    )

    const error = screen.getByLabelText('report.pdf: report.pdf is larger than 7.5 MB.')
    const remove = screen.getByRole('button', { name: 'Remove report.pdf' })
    expect(error).not.toBe(remove)
    expect(remove.parentElement?.getAttribute('aria-label')).toBeNull()

    fireEvent.click(remove)
    expect(onRemove).toHaveBeenCalledWith('failed-file')
  })
})
