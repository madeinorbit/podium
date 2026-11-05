import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { type ChatGalleryImage, ChatImageGallery } from './ChatImageGallery'

afterEach(cleanup)

const items: ChatGalleryImage[] = Array.from({ length: 6 }, (_, i) => ({
  kind: 'image',
  src: `/image-${i}.png`,
  label: `Reference ${i + 1}.png`,
  path: `/repo/image-${i}.png`,
}))

it('opens the clicked image with its complete ordered album, including overflow', () => {
  const open = vi.fn()
  render(<ChatImageGallery items={items} onOpenImage={open} />)
  expect(screen.getAllByRole('img')).toHaveLength(3)
  expect(screen.getByText('+3')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Open Reference 3.png, image 3 of 6' }))
  expect(open).toHaveBeenLastCalledWith('/image-2.png', items, 2)
  fireEvent.click(screen.getByRole('button', { name: 'View all' }))
  expect(open).toHaveBeenLastCalledWith('/image-0.png', items, 0)
})

it('keeps a failed image named and opens its file when one is available', () => {
  const open = vi.fn(),
    openFile = vi.fn()
  render(<ChatImageGallery items={items.slice(0, 1)} onOpenImage={open} onOpenFile={openFile} />)
  fireEvent.error(screen.getByRole('img'))
  expect(screen.getByText('Preview unavailable')).toBeTruthy()
  expect(screen.queryByRole('img')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Open Reference 1.png, image 1 of 1' }))
  expect(openFile).toHaveBeenCalledWith('/repo/image-0.png')
  expect(open).not.toHaveBeenCalled()
})

it('retries a failed preview when a durable copy replaces the staged URL', () => {
  const view = render(<ChatImageGallery items={items.slice(0, 1)} onOpenImage={() => {}} />)
  fireEvent.error(screen.getByRole('img'))
  view.rerender(
    <ChatImageGallery
      items={[{ kind: 'image', label: 'Reference 1.png', src: '/saved-copy.png' }]}
      onOpenImage={() => {}}
    />,
  )
  expect(screen.getByRole('img').getAttribute('src')).toBe('/saved-copy.png')
  expect(screen.queryByText('Preview unavailable')).toBeNull()
})

it('preserves the selected position when the same image was attached twice', () => {
  const duplicate: ChatGalleryImage = { kind: 'image', src: '/same.png', label: 'Same image.png' }
  const album = [duplicate, duplicate]
  const open = vi.fn()
  render(<ChatImageGallery items={album} onOpenImage={open} />)
  fireEvent.click(screen.getByRole('button', { name: 'Open Same image.png, image 2 of 2' }))
  expect(open).toHaveBeenCalledWith('/same.png', album, 1)
})
