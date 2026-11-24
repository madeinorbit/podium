import { createElement, useLayoutEffect, useRef, useState } from 'react'
import { View } from 'react-native'
import { ArtifactVideoPlayButton } from './ArtifactVideoPlayButton'

export function ArtifactVideo({
  url,
  label,
}: {
  url: string
  bearer: string | null
  label: string
}) {
  const video = useRef<HTMLVideoElement>(null)
  const [started, setStarted] = useState(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: changing source stops the previous playback.
  useLayoutEffect(() => {
    setStarted(false)
    const element = video.current
    return () => element?.pause()
  }, [url])
  return (
    <View style={{ width: '100%', height: '100%' }}>
      {createElement('video', {
        ref: video,
        src: url,
        controls: true,
        autoPlay: false,
        playsInline: true,
        onPlaying: () => setStarted(true),
        'aria-label': label,
        style: { width: '100%', height: '100%', backgroundColor: '#000' },
      })}
      {!started ? (
        <ArtifactVideoPlayButton
          label={label}
          onPress={() => {
            // Keep the action available if the browser rejects playback.
            void video.current?.play().catch(() => {})
          }}
        />
      ) : null}
    </View>
  )
}
