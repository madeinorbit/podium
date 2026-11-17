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
  it('keeps the native corner badge small and expands only its touch area to 44 points', () => {
    render(
      <AttachmentStrip
        attachments={[
          { id: 'photo', name: 'photo.png', previewUri: 'file:///photo.png', state: 'ready' },
        ]}
        onRemove={vi.fn()}
      />,
    )
    const badge = screen.getByRole('button', { name: 'Remove photo.png' })
    const style = getComputedStyle(badge)
    expect(style.width).toBe('18px')
    expect(style.height).toBe('18px')
    expect(style.minWidth).toBe('18px')
    expect(style.minHeight).toBe('18px')
    expect(native.remove?.hitSlop).toBe(13)
    expect(18 + 2 * Number(native.remove?.hitSlop)).toBe(44)
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
