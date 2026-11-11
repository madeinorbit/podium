import { useVideoPlayer, VideoView } from 'expo-video'
import { type ComponentProps, useLayoutEffect, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { authenticatedVideoSource } from '../client/authenticated-assets'
import { ArtifactVideoPlayButton } from './ArtifactVideoPlayButton'

export function ArtifactVideo({
  url,
  bearer,
  label,
}: {
  url: string
  bearer: string | null
  label: string
}) {
  const player = useVideoPlayer(authenticatedVideoSource(url, bearer))
  const [started, setStarted] = useState(false)
  // Stop audio in layout cleanup, before Expo releases the player on unmount.
  useLayoutEffect(() => {
    setStarted(false)
    const subscription = player.addListener('playingChange', ({ isPlaying }) => {
      if (isPlaying) setStarted(true)
    })
    return () => {
      subscription.remove()
      player.pause()
    }
  }, [player])

  return (
    <View style={styles.media}>
      <VideoView
        // SDK 57's web-first declarations narrow this prop to an intersection even
        // though the universal hook returns the same native VideoPlayer at runtime.
        player={player as ComponentProps<typeof VideoView>['player']}
        style={styles.media}
        contentFit="contain"
        nativeControls
        fullscreenOptions={{ enable: true }}
        accessibilityLabel={label}
      />
      {!started ? <ArtifactVideoPlayButton label={label} onPress={() => player.play()} /> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  media: {
    width: '100%',
    height: '100%',
  },
})
