import { useRef, useState } from 'react'
import {
  Image,
  type ImageLoadEvent,
  type ImageSourcePropType,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  PixelRatio,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native'
import { GestureDetector, useTapGesture } from 'react-native-gesture-handler'

export interface Size {
  width: number
  height: number
}

/** Scales this close to fit count as fit: UIKit settles a zoom-out a hair off 1. */
const AT_FIT = 1.01
/** Where a double tap zooms to, as a multiple of fit. */
export const DOUBLE_TAP_ZOOM = 2.5

/** Whether a scroll view's zoom scale is past fit (scale 1 is fit). */
export function isZoomed(scale: number | undefined): boolean {
  return (scale ?? 1) > AT_FIT
}

/** The largest size with the image's aspect ratio that fits the box, small
 *  images scaled up like Photos does. Unknown sizes fall back to the box. */
export function fitSize(natural: Size | null, box: Size): Size {
  if (!natural || natural.width <= 0 || natural.height <= 0) return box
  const scale = Math.min(box.width / natural.width, box.height / natural.height)
  return { width: natural.width * scale, height: natural.height * scale }
}

/** The deepest zoom: at least 4×, and far enough to reach the image's own
 *  pixels at twice their size, capped at 8×. */
export function maxZoomFor(natural: Size | null, fitted: Size, pixelRatio: number): number {
  if (!natural || fitted.width <= 0) return 4
  const toPixels = natural.width / pixelRatio / fitted.width
  return Math.min(8, Math.max(4, toPixels * 2))
}

/** The content rect a double tap zooms into: `scale`× fit, centred on the tap
 *  (in unzoomed content points). UIScrollView clamps it to the content. */
export function zoomRectAt(point: { x: number; y: number }, box: Size, scale: number) {
  const width = box.width / scale
  const height = box.height / scale
  return { x: point.x - width / 2, y: point.y - height / 2, width, height }
}

/**
 * A full-screen image on the system zooming scroll view (UIScrollView, as in
 * Photos): pinch, double tap to zoom in at the tap and again back to fit, pan
 * while zoomed, rubber-banding past either limit, and the image recentred
 * whenever it is smaller than the screen. Fit is the minimum zoom.
 *
 * At fit the scroll view does not pan, so a one-finger drag stays free for the
 * viewer's pull-to-dismiss and the pager around it; `onZoomChange` tells the
 * owner when the image leaves fit and comes back, so it can hold those still.
 */
export function ZoomableImage({
  source,
  label,
  onZoomChange,
  onError,
}: {
  source: ImageSourcePropType
  label: string
  onZoomChange?: (zoomed: boolean) => void
  onError?: () => void
}) {
  const scroller = useRef<ScrollView>(null)
  const [box, setBox] = useState<Size | null>(null)
  const [natural, setNatural] = useState<Size | null>(null)
  const [zoomed, setZoomed] = useState(false)
  // Read by the tap and scroll handlers between renders.
  const zoomedNow = useRef(false)
  const fitted = box ? fitSize(natural, box) : null

  const report = (scale: number | undefined) => {
    const next = isZoomed(scale)
    if (next === zoomedNow.current) return
    zoomedNow.current = next
    setZoomed(next)
    onZoomChange?.(next)
  }

  const doubleTap = useTapGesture({
    numberOfTaps: 2,
    runOnJS: true,
    onActivate: (event) => {
      if (!box || !fitted) return
      const rect = zoomedNow.current
        ? { x: 0, y: 0, width: fitted.width, height: fitted.height }
        : zoomRectAt({ x: event.x, y: event.y }, box, DOUBLE_TAP_ZOOM)
      scroller.current?.scrollResponderZoomTo({ ...rect, animated: true })
    },
  })

  const onLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout
    if (!box || box.width !== width || box.height !== height) setBox({ width, height })
  }
  const onLoad = (event: ImageLoadEvent) => {
    const { width, height } = event.nativeEvent.source
    if (width > 0 && height > 0) setNatural({ width, height })
  }

  return (
    <View style={styles.fill} onLayout={onLayout} testID="artifact-zoom">
      {box && fitted ? (
        <ScrollView
          ref={scroller}
          style={styles.fill}
          contentContainerStyle={{ width: fitted.width, height: fitted.height }}
          centerContent
          minimumZoomScale={1}
          maximumZoomScale={maxZoomFor(natural, fitted, PixelRatio.get())}
          bouncesZoom
          // Pinch works either way; panning only once there is somewhere to go.
          scrollEnabled={zoomed}
          alwaysBounceHorizontal={false}
          alwaysBounceVertical={false}
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
          scrollEventThrottle={16}
          onScroll={(event: NativeSyntheticEvent<NativeScrollEvent>) =>
            report(event.nativeEvent.zoomScale)
          }
          testID="artifact-zoom-scroll"
        >
          <GestureDetector gesture={doubleTap}>
            <Image
              source={source}
              style={{ width: fitted.width, height: fitted.height }}
              resizeMode="contain"
              accessibilityLabel={label}
              onLoad={onLoad}
              onError={onError}
            />
          </GestureDetector>
        </ScrollView>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1, alignSelf: 'stretch' },
})
