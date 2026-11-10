import { useVideoPlayer, VideoView } from 'expo-video'
import { type ComponentProps, useLayoutEffect } from 'react'
import { StyleSheet } from 'react-native'
import { authenticatedVideoSource } from '../client/authenticated-assets'

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
  // Stop audio in layout cleanup, before Expo releases the player on unmount.
  useLayoutEffect(() => () => player.pause(), [player])

  return (
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
  )
}

const styles = StyleSheet.create({
  media: {
    width: '100%',
    height: '100%',
  },
})
