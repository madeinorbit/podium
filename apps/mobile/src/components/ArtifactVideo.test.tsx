import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({
  play: vi.fn(),
  pause: vi.fn(),
  release: vi.fn(),
  events: [] as string[],
  playingChange: null as ((event: { isPlaying: boolean }) => void) | null,
}))
vi.mock('expo-video', async () => {
  const { useEffect, useMemo } = await import('react')
  return {
    VideoView: () => <div>Native controls</div>,
    useVideoPlayer: (_source: unknown, setup?: (player: unknown) => void) => {
      const player = useMemo(
        () => ({
          play: calls.play,
          addListener: (_name: string, listener: (event: { isPlaying: boolean }) => void) => {
            calls.playingChange = listener
            return {
              remove: () => {
                calls.playingChange = null
              },
            }
          },
          pause: () => {
            calls.pause()
            calls.events.push('pause')
          },
          release: () => {
            calls.release()
            calls.events.push('release')
          },
        }),
        [],
      )
      useMemo(() => setup?.(player), [player, setup])
      useEffect(() => () => player.release(), [player])
      return player
    },
  }
})
const { ArtifactVideo: NativeVideo } = await import('./ArtifactVideo.native')
const { ArtifactVideo: WebVideo } = await import('./ArtifactVideo.web')
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  calls.events.length = 0
})
it('native video stays paused on every page opening and pauses before release on exit', () => {
  const view = render(
    <NativeVideo url="https://example.test/video.mp4" bearer={null} label="Video" />,
  )
  expect(calls.play).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Play Video' }))
  expect(calls.play).toHaveBeenCalledOnce()
  expect(screen.getByRole('button', { name: 'Play Video' })).toBeTruthy()
  act(() => calls.playingChange?.({ isPlaying: true }))
  expect(screen.queryByRole('button', { name: 'Play Video' })).toBeNull()
  act(() => calls.playingChange?.({ isPlaying: false }))
  expect(screen.queryByRole('button', { name: 'Play Video' })).toBeNull()
  view.unmount()
  expect(calls.playingChange).toBeNull()
  expect(calls.events).toEqual(['pause', 'release'])
  calls.play.mockClear()
  render(<NativeVideo url="https://example.test/video.mp4" bearer={null} label="Video" />)
  expect(calls.play).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Play Video' })).toBeTruthy()
})
it('web video has controls without autoplay and pauses when its page leaves', () => {
  const view = render(<WebVideo url="https://example.test/video.mp4" bearer={null} label="Video" />)
  const video = view.container.querySelector('video')
  if (!video) throw new Error('Missing video')
  expect(video.autoplay).toBe(false)
  expect(video.controls).toBe(true)
  const play = vi.spyOn(video, 'play').mockResolvedValue()
  fireEvent.click(screen.getByRole('button', { name: 'Play Video' }))
  expect(play).toHaveBeenCalledOnce()
  expect(screen.getByRole('button', { name: 'Play Video' })).toBeTruthy()
  fireEvent.playing(video)
  expect(screen.queryByRole('button', { name: 'Play Video' })).toBeNull()
  fireEvent.pause(video)
  expect(screen.queryByRole('button', { name: 'Play Video' })).toBeNull()
  const pause = vi.spyOn(video, 'pause')
  view.unmount()
  expect(pause).toHaveBeenCalledOnce()
})

it('keeps the web play action available after rejection and resets it for a new source', async () => {
  const view = render(<WebVideo url="https://example.test/one.mp4" bearer={null} label="One" />)
  const video = view.container.querySelector('video')
  if (!video) throw new Error('Missing video')
  vi.spyOn(video, 'play').mockRejectedValue(new Error('Not ready'))
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Play One' })))
  expect(screen.getByRole('button', { name: 'Play One' })).toBeTruthy()
  fireEvent.playing(video)
  view.rerender(<WebVideo url="https://example.test/two.mp4" bearer={null} label="Two" />)
  expect(screen.getByRole('button', { name: 'Play Two' })).toBeTruthy()
})
