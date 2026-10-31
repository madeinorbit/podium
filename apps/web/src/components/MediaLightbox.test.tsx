import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ImageLightbox } from '@/features/chat/ImageLightbox'
import { MediaLightbox, type MediaLightboxItem } from './MediaLightbox'

afterEach(cleanup)

const ITEMS: MediaLightboxItem[] = [
  { kind: 'image', src: '/first.png', label: 'First image' },
  { kind: 'video', src: '/clip.mp4', label: 'Video clip' },
  { kind: 'image', src: '/last.png', label: 'Last image' },
]

function Gallery() {
  const [index, setIndex] = useState(0)
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open gallery
      </button>
      {open && (
        <MediaLightbox
          items={ITEMS}
          index={index}
          onIndexChange={setIndex}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

describe('MediaLightbox', () => {
  it('navigates images and videos with buttons and arrows, wrapping at both ends', () => {
    render(<Gallery />)
    fireEvent.click(screen.getByRole('button', { name: 'Open gallery' }))
    expect(screen.getByRole('img', { name: 'First image' })).toBeTruthy()

    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    expect(screen.getByRole('img', { name: 'Last image' })).toBeTruthy()
    expect(screen.getByText('3 / 3')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Next artifact' }))
    expect(screen.getByRole('img', { name: 'First image' })).toBeTruthy()
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(screen.getByLabelText('Video clip').tagName).toBe('VIDEO')
    fireEvent.click(screen.getByRole('button', { name: 'Previous artifact' }))
    expect(screen.getByRole('img', { name: 'First image' })).toBeTruthy()
  })

  it('cancels Escape before closing, shields the page, and releases the key after closing', async () => {
    const pageKey = vi.fn()
    window.addEventListener('keydown', pageKey)
    try {
      render(<Gallery />)
      const trigger = screen.getByRole('button', { name: 'Open gallery' })
      trigger.focus()
      fireEvent.click(trigger)
      await waitFor(() =>
        expect(document.activeElement).toBe(screen.getByLabelText('Close preview')),
      )

      const escapeEvent = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      })
      fireEvent(document.activeElement as Element, escapeEvent)
      expect(escapeEvent.defaultPrevented).toBe(true)
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(pageKey).not.toHaveBeenCalled()
      await waitFor(() => expect(document.activeElement).toBe(trigger))

      const nextEscape = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      })
      fireEvent(trigger, nextEscape)
      expect(nextEscape.defaultPrevented).toBe(false)
      expect(pageKey).toHaveBeenCalledOnce()
    } finally {
      window.removeEventListener('keydown', pageKey)
    }
  })

  it('keeps video arrow controls and modified shortcuts intact', () => {
    render(<Gallery />)
    fireEvent.click(screen.getByRole('button', { name: 'Open gallery' }))
    fireEvent.keyDown(window, { key: 'ArrowRight', metaKey: true })
    expect(screen.getByRole('img', { name: 'First image' })).toBeTruthy()
    fireEvent.keyDown(window, { key: 'ArrowRight' })

    const video = screen.getByLabelText('Video clip')
    const arrow = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      bubbles: true,
      cancelable: true,
    })
    fireEvent(video, arrow)
    expect(arrow.defaultPrevented).toBe(false)
    expect(screen.getByText('2 / 3')).toBeTruthy()
  })

  it('keeps media clicks inside the preview and closes on the backdrop', () => {
    const cardClick = vi.fn()
    render(
      // biome-ignore lint/a11y/noStaticElementInteractions: stand-in for an enclosing offer card
      // biome-ignore lint/a11y/useKeyWithClickEvents: test scaffold
      <div onClick={cardClick}>
        <Gallery />
      </div>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Open gallery' }))
    cardClick.mockClear()
    fireEvent.click(screen.getByRole('img', { name: 'First image' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next artifact' }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(cardClick).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('dialog'))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(cardClick).not.toHaveBeenCalled()
  })

  it('uses the same Escape cancellation for a single transcript image without gallery controls', () => {
    const onClose = vi.fn()
    render(<ImageLightbox src="/attachment.png" onClose={onClose} />)
    expect(screen.queryByLabelText('Next artifact')).toBeNull()
    expect(screen.queryByLabelText('Previous artifact')).toBeNull()
    const escapeEvent = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    })
    fireEvent(window, escapeEvent)
    expect(escapeEvent.defaultPrevented).toBe(true)
    expect(onClose).toHaveBeenCalledOnce()
  })
})
