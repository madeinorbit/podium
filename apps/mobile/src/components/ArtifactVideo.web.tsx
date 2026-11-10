import { createElement, useLayoutEffect, useRef } from 'react'

export function ArtifactVideo({
  url,
  label,
}: {
  url: string
  bearer: string | null
  label: string
}) {
  const video = useRef<HTMLVideoElement>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: changing source stops the previous playback.
  useLayoutEffect(() => {
    const element = video.current
    return () => element?.pause()
  }, [url])
  return createElement('video', {
    ref: video,
    src: url,
    controls: true,
    autoPlay: false,
    'aria-label': label,
    style: { width: '100%', height: '100%', backgroundColor: '#000' },
  })
}
