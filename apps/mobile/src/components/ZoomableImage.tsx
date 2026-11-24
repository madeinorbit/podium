import { useEffect, useRef, useState } from 'react'
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
import { scheduleOnRN } from 'react-native-worklets'

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

/** The insets that centre fitted content in the box (UIKit's centerContent). */
export function fitInsets(fitted: Size, box: Size) {
  const x = Math.max(0, (box.width - fitted.width) / 2)
  const y = Math.max(0, (box.height - fitted.height) / 2)
  return { top: y, bottom: y, left: x, right: x }
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
  // The image's own size is known (or could not be read): only then does the
  // scroll view mount, because UIKit centres content when the scroll view is
  // laid out and not when its content size changes later.
  const [measured, setMeasured] = useState(false)
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

  const zoomAt = (x: number, y: number) => {
    if (!box || !fitted) return
    const rect = zoomedNow.current
      ? { x: 0, y: 0, width: fitted.width, height: fitted.height }
      : zoomRectAt({ x, y }, box, DOUBLE_TAP_ZOOM)
    scroller.current?.scrollResponderZoomTo({ ...rect, animated: true })
  }
  // The worklets plugin turns every gesture callback into a worklet; it hands
  // only the tap point back, never the refs, to the JS thread.
  const doubleTap = useTapGesture({
    numberOfTaps: 2,
    onActivate: (event) => {
      'worklet'
      scheduleOnRN(zoomAt, event.x, event.y)
    },
  })

  // A remote { uri, headers } source (artifacts carry the bearer header).
  const remote =
    source && typeof source === 'object' && !Array.isArray(source)
      ? (source as { uri?: string; headers?: Record<string, string> })
      : null
  const uri = remote?.uri
  const headers = remote?.headers ? JSON.stringify(remote.headers) : undefined
  useEffect(() => {
    setMeasured(false)
    if (!uri) {
      setMeasured(true)
      return
    }
    let live = true
    const size = headers
      ? Image.getSizeWithHeaders(uri, JSON.parse(headers) as Record<string, string>)
      : Image.getSize(uri)
    size
      .then(({ width, height }) => {
        if (live && width > 0 && height > 0) setNatural({ width, height })
      })
      .catch(() => {})
      .finally(() => {
        if (live) setMeasured(true)
      })
    return () => {
      live = false
    }
  }, [uri, headers])

  const onLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout
    if (!box || box.width !== width || box.height !== height) setBox({ width, height })
  }
  // Fallback when the size could not be read up front.
  const onLoad = (event: ImageLoadEvent) => {
    const { width, height } = event.nativeEvent.source
    if (!natural && width > 0 && height > 0) setNatural({ width, height })
  }

  return (
    <View style={styles.fill} onLayout={onLayout} testID="artifact-zoom">
      {box && fitted && measured ? (
        <ScrollView
          // A new fitted size remounts it, so UIKit centres the new content.
          key={`${Math.round(fitted.width)}x${Math.round(fitted.height)}`}
          ref={scroller}
          style={styles.fill}
          contentContainerStyle={{ width: fitted.width, height: fitted.height }}
          // UIKit recentres while zooming (centerContent); the fit insets are
          // also stated outright, because Fabric recycles scroll views and
          // re-applies the previous image's centring on the way (RN 0.86
          // prepareForRecycle re-centres on the old content size), which an
          // inset prop overrides when the next image mounts.
          centerContent
          contentInset={fitInsets(fitted, box)}
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
