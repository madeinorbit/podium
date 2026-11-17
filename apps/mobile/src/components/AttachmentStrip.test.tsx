import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { Pressable, View } from 'react-native'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AttachmentStrip } from './AttachmentStrip'

const native = vi.hoisted(() => ({
  remove: undefined as ComponentProps<typeof Pressable> | undefined,
}))
vi.mock('react-native', async (original) => {
  const rn = await original<typeof import('react-native')>()
  const { forwardRef } = await import('react')
  return {
    ...rn,
    Platform: {
      ...rn.Platform,
      OS: 'ios',
      select: (options: Record<string, unknown>) => options.ios ?? options.default,
    },
    Pressable: forwardRef<View, ComponentProps<typeof Pressable>>((props, ref) => {
      if (props.accessibilityLabel?.startsWith('Remove ')) native.remove = props
      return <rn.Pressable {...props} ref={ref} />
    }),
  }
})

afterEach(cleanup)

describe('AttachmentStrip accessibility', () => {
  it('keeps the corner badge inside a clear 44 point target, as in New Task', () => {
    render(
      <AttachmentStrip
        attachments={[
          { id: 'photo', name: 'photo.png', previewUri: 'file:///photo.png', state: 'ready' },
        ]}
        onRemove={vi.fn()}
      />,
    )
    const remove = screen.getByRole('button', { name: 'Remove photo.png' })
    const style = getComputedStyle(remove)
    expect(style.width).toBe('44px')
    expect(style.height).toBe('44px')
    expect(style.backgroundColor).toMatch(/, 0(?:\.0+)?\)$/)
    const badge = remove.firstElementChild
    if (!badge) throw new Error('Missing corner badge')
    expect(getComputedStyle(badge).width).toBe('20px')
    expect(getComputedStyle(badge).height).toBe('20px')
    expect(native.remove?.hitSlop).toBe(8)
  })

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
