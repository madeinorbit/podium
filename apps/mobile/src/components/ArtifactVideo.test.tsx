import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({
  play: vi.fn(),
  pause: vi.fn(),
  release: vi.fn(),
  events: [] as string[],
}))
vi.mock('expo-video', async () => {
  const { useEffect, useMemo } = await import('react')
  return {
    VideoView: () => <div>Native controls</div>,
    useVideoPlayer: (_source: unknown, setup?: (player: unknown) => void) => {
      const player = useMemo(
        () => ({
          play: calls.play,
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
  view.unmount()
  expect(calls.events).toEqual(['pause', 'release'])
  render(<NativeVideo url="https://example.test/video.mp4" bearer={null} label="Video" />)
  expect(calls.play).not.toHaveBeenCalled()
})
it('web video has controls without autoplay and pauses when its page leaves', () => {
  const view = render(<WebVideo url="https://example.test/video.mp4" bearer={null} label="Video" />)
  const video = view.container.querySelector('video')
  if (!video) throw new Error('Missing video')
  expect(video.autoplay).toBe(false)
  expect(video.controls).toBe(true)
  const pause = vi.spyOn(video, 'pause')
  view.unmount()
  expect(pause).toHaveBeenCalledOnce()
})
