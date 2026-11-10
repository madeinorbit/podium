import type { IssuePanelArtifact } from '@podium/model'
import { type ComponentType, createElement, useEffect, useRef, useState } from 'react'
import {
  Image,
  Modal,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  ScrollView,
  Share,
  type StyleProp,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type ViewStyle,
} from 'react-native'
import {
  GestureDetector,
  GestureHandlerRootView,
  usePanGesture,
} from 'react-native-gesture-handler'
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { scheduleOnRN } from 'react-native-worklets'
import {
  authenticatedImageSource,
  fetchAuthenticatedAsset,
  readAuthenticatedTextPreview,
} from '../client/authenticated-assets'
// Read the profile without importing the gate's boot graph.
import { useServerProfile } from '../client/server-profile-context'
import {
  endAtTagBoundary,
  htmlDataUri,
  htmlWithBase,
  type IssueArtifactPreview,
  issueArtifactLabel,
  issueArtifactPreview,
} from '../lib/issue-artifacts'
import { color, font, leading, mono, sans, space, spring } from '../theme/theme'
import { ArtifactVideo } from './ArtifactVideo'
import { Icon } from './Icon'
import { type AppIcon, X } from './icons'
import { PressableScale } from './PressableScale'
import { RichMarkdown } from './RichMarkdown'

const HTML_CAP = 2 * 1024 * 1024
/** How far a released drag must travel, or how fast, to close the viewer. */
const CLOSE_DISTANCE = 120
const CLOSE_VELOCITY = 800
/** Pulling a document this far past its top and letting go closes it too. */
const PULL_CLOSE = 72
const ShareIcon: AppIcon = { ios: 'square.and.arrow.up', android: 'share', web: 'share' }

/**
 * The DOM-components WebView the app already ships. `@expo/dom-webview` is a
 * hard dependency of expo SDK 57 and its native module is autolinked into the
 * binary, but it is resolved lazily (the way expo's own webview-wrapper does)
 * so the web bundle and the test graph never load a native view manager. A
 * binary somehow built without it degrades to the source-text fallback.
 */
type DomWebViewComponent = ComponentType<{
  source: { uri: string }
  style?: StyleProp<ViewStyle>
  containerStyle?: StyleProp<ViewStyle>
  /** WebKit killed the render process — on a phone, almost always memory. */
  onContentProcessDidTerminate?: () => void
}>
let domWebViewCache: DomWebViewComponent | null | undefined
function resolveDomWebView(): DomWebViewComponent | null {
  if (domWebViewCache === undefined) {
    try {
      domWebViewCache = (require('@expo/dom-webview') as { WebView: DomWebViewComponent }).WebView
    } catch {
      domWebViewCache = null
    }
  }
  return domWebViewCache
}

/** One artifact the viewer can page to. */
export interface ArtifactViewerItem {
  key: string
  artifact: IssuePanelArtifact
  /** Absent when this phone cannot reach the file. */
  url: string | null
}

/**
 * In-app issue artifact viewer (boards Artifact, ArtifactDrag): full screen on
 * an opaque ground, the artifact's name over "2 of 3", swipe sideways between
 * the list it was opened from, drag down (or pull a document past its top) to
 * close. Images and video fill the page; HTML concepts render in a same-origin
 * frame; markdown and text are fetched and shown here. Leaving the PWA via
 * Linking.openURL dropped the session cookie and made artifacts unreadable on
 * the phone.
 *
 * Callers pass `items` and the opened `index` to page through a list, or a
 * single `artifact` and `url`.
 */
export function ArtifactViewer({
  artifact,
  url,
  items,
  index = 0,
  onClose,
}: {
  artifact?: IssuePanelArtifact | null
  url?: string | null
  items?: readonly ArtifactViewerItem[]
  index?: number
  onClose: () => void
}) {
  const list: readonly ArtifactViewerItem[] =
    items && items.length > 0
      ? items
      : artifact
        ? [{ key: `${artifact.path}@${artifact.addedAt}`, artifact, url: url ?? null }]
        : []
  if (list.length === 0) return null
  return (
    <Modal visible transparent animationType="fade" statusBarTranslucent onRequestClose={onClose}>
      <ViewerPages
        items={list}
        start={Math.min(Math.max(0, index), list.length - 1)}
        onClose={onClose}
      />
    </Modal>
  )
}

function ViewerPages({
  items,
  start,
  onClose,
}: {
  items: readonly ArtifactViewerItem[]
  start: number
  onClose: () => void
}) {
  const insets = useSafeAreaInsets()
  const { width, height } = useWindowDimensions()
  const [page, setPage] = useState(start)
  const pager = useRef<ScrollView>(null)
  const drag = useSharedValue(0)
  const current = items[page] ?? items[0]!
  const label = issueArtifactLabel(current.artifact)
  const many = items.length > 1

  // Open on the tapped artifact, not the first page.
  useEffect(() => {
    if (start > 0) pager.current?.scrollTo({ x: start * width, animated: false })
  }, [start, width])

  const close = () => onClose()
  const pan = usePanGesture({
    activeOffsetY: 12,
    failOffsetX: [-16, 16],
    onUpdate: (event) => {
      'worklet'
      drag.set(Math.max(0, event.translationY))
    },
    onDeactivate: (event) => {
      'worklet'
      if (event.translationY > CLOSE_DISTANCE || event.velocityY > CLOSE_VELOCITY) {
        drag.set(withTiming(height, { duration: 180 }, () => scheduleOnRN(close)))
      } else {
        drag.set(withSpring(0, spring.snappy))
      }
    },
  })

  // The ground fades and the page shrinks toward a card as it is pulled down,
  // so the screen it came from shows through (board ArtifactDrag). At rest the
  // ground is opaque.
  const groundStyle = useAnimatedStyle(() => ({
    opacity: interpolate(drag.get(), [0, height * 0.6], [1, 0.38], Extrapolation.CLAMP),
  }))
  const pageStyle = useAnimatedStyle(() => {
    const y = drag.get()
    const scale = interpolate(y, [0, height * 0.6], [1, 0.78], Extrapolation.CLAMP)
    return {
      borderRadius: interpolate(y, [0, 40], [0, 12], Extrapolation.CLAMP),
      transform: [{ translateY: y }, { scale }],
    }
  })
  const chromeStyle = useAnimatedStyle(() => ({
    opacity: interpolate(drag.get(), [0, 60], [1, 0], Extrapolation.CLAMP),
  }))

  const onPage = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const next = Math.round(event.nativeEvent.contentOffset.x / Math.max(1, width))
    if (next !== page && next >= 0 && next < items.length) setPage(next)
  }

  const share = () => {
    if (!current.url) return
    void Share.share({ url: current.url, message: current.url, title: label }).catch(() => {})
  }

  return (
    <GestureHandlerRootView style={styles.fill}>
      <Animated.View style={[StyleSheet.absoluteFill, styles.ground, groundStyle]} />
      <GestureDetector gesture={pan}>
        <Animated.View style={[styles.fill, styles.page, pageStyle]} testID="artifact-viewer">
          <Animated.View style={[styles.bar, { paddingTop: insets.top + space.sm }, chromeStyle]}>
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel="Close artifact"
              onPress={onClose}
              style={styles.cap}
            >
              <Icon as={X} size={18} color={color.text} />
            </PressableScale>
            <View style={styles.heading}>
              <Text style={styles.title} numberOfLines={1} accessibilityRole="header">
                {label}
              </Text>
              {many ? (
                <Text style={styles.position} testID="artifact-position">
                  {`${page + 1} of ${items.length}`}
                </Text>
              ) : null}
            </View>
            {Platform.OS !== 'web' && current.url ? (
              <PressableScale
                accessibilityRole="button"
                accessibilityLabel="Share artifact"
                onPress={share}
                style={styles.cap}
              >
                <Icon as={ShareIcon} size={18} color={color.text} />
              </PressableScale>
            ) : (
              <View style={styles.capSpace} />
            )}
          </Animated.View>
          <ScrollView
            ref={pager}
            horizontal
            pagingEnabled
            scrollEnabled={many}
            showsHorizontalScrollIndicator={false}
            onMomentumScrollEnd={onPage}
            onScroll={Platform.OS === 'web' ? onPage : undefined}
            scrollEventThrottle={64}
            style={styles.fill}
          >
            {items.map((item, at) => (
              <View key={item.key} style={[styles.slide, { width }]}>
                {Math.abs(at - page) <= 1 ? (
                  <ArtifactBody
                    preview={issueArtifactPreview(item.artifact.entry ?? item.artifact.path)}
                    url={item.url}
                    label={issueArtifactLabel(item.artifact)}
                    onPullClose={onClose}
                  />
                ) : null}
              </View>
            ))}
          </ScrollView>
          {many ? (
            <Animated.View
              style={[styles.dots, { paddingBottom: insets.bottom + space.sm }, chromeStyle]}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            >
              {items.map((item, at) => (
                <View key={item.key} style={[styles.dot, at === page && styles.dotOn]} />
              ))}
            </Animated.View>
          ) : (
            <View style={{ height: insets.bottom + space.sm }} />
          )}
        </Animated.View>
      </GestureDetector>
    </GestureHandlerRootView>
  )
}

function ArtifactBody({
  preview,
  url,
  label,
  onPullClose,
}: {
  preview: IssueArtifactPreview
  url: string | null
  label: string
  onPullClose: () => void
}) {
  const { bearer } = useServerProfile()
  if (!url) {
    return <Text style={styles.note}>This file is not reachable from this phone.</Text>
  }
  if (preview === 'image') {
    return (
      <Image
        source={authenticatedImageSource(url, bearer)}
        style={styles.media}
        resizeMode="contain"
        accessibilityLabel={label}
      />
    )
  }
  if (preview === 'video') {
    return <ArtifactVideo url={url} bearer={bearer} label={label} />
  }
  if (preview === 'html') {
    if (Platform.OS === 'web') {
      return createElement('iframe', {
        src: url,
        title: label,
        style: {
          width: '100%',
          height: '100%',
          border: 'none',
          backgroundColor: '#fff',
        },
      })
    }
    return <HtmlWebView url={url} bearer={bearer} />
  }
  if (preview === 'markdown')
    return <FetchedText url={url} asMarkdown bearer={bearer} onPullClose={onPullClose} />
  return <FetchedText url={url} asMarkdown={false} bearer={bearer} onPullClose={onPullClose} />
}

/**
 * Native HTML artifact viewer — the phone's version of the desktop's browser
 * view, on the WebView runtime the app already bundles for DOM components.
 *
 * The document cannot be pointed at the URL directly: /files/* wants the
 * bearer header on native and a WebView's own navigation cannot carry one. So
 * the bytes come down the same authenticated fetch path every other preview
 * uses, get anchored with a `<base>` (see {@link htmlWithBase}), and render
 * from a data: URI. Relative subresources resolve against the server through
 * that base and load wherever the deployment serves /files/* without login;
 * behind login they 404 into a still-readable page rather than a blank one.
 */
function HtmlWebView({ url, bearer }: { url: string; bearer: string | null }) {
  const [doc, setDoc] = useState<string | null>(null)
  const [clipped, setClipped] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setDoc(null)
    setClipped(false)
    setError(null)
    void fetchAuthenticatedAsset(url, bearer)
      .then(async (res) => {
        if (!res.ok) throw new Error(`Could not load (${res.status})`)
        const buf = await res.arrayBuffer()
        const overCap = buf.byteLength > HTML_CAP
        const decoded = new TextDecoder().decode(overCap ? buf.slice(0, HTML_CAP) : buf)
        const html = overCap ? endAtTagBoundary(decoded) : decoded
        if (!alive) return
        setClipped(overCap)
        setDoc(htmlDataUri(htmlWithBase(html, url)))
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      alive = false
    }
  }, [bearer, url])

  const WebView = resolveDomWebView()
  // No webview in this binary: the source is still worth reading, but say why
  // it is markup rather than a page — an unexplained wall of HTML is the same
  // report as a blank one ("the artifact does not open").
  if (!WebView) {
    return (
      <FetchedText
        url={url}
        asMarkdown={false}
        bearer={bearer}
        note="This build has no web view, so the page is shown as source."
      />
    )
  }
  if (error) return <Text style={styles.note}>{error}</Text>
  if (doc === null) return <Text style={styles.note}>Loading…</Text>
  return (
    <View style={styles.webFrame} testID="artifact-html-webview">
      {clipped ? (
        <Text style={styles.clip}>
          Preview clipped at {Math.round(HTML_CAP / (1024 * 1024))} MB — open it on a desktop to
          read the rest.
        </Text>
      ) : null}
      <WebView
        source={{ uri: doc }}
        style={styles.webView}
        // A blank frame is the one failure a reader cannot interpret. iOS kills
        // the WebContent process on a heavy page (far sooner on a phone than in
        // the simulator), and the view is left showing nothing at all; say so.
        onContentProcessDidTerminate={() =>
          setError('The phone stopped this preview — the page is too heavy to render here.')
        }
      />
    </View>
  )
}

function FetchedText({
  url,
  asMarkdown,
  bearer,
  note,
  onPullClose,
}: {
  url: string
  asMarkdown: boolean
  bearer: string | null
  /** Why this is source text rather than the rendered thing, when it is. */
  note?: string
  /** A document scrolls, so the viewer's drag cannot own it: pulling it past
   *  its top and letting go closes the viewer instead. */
  onPullClose?: () => void
}) {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setText(null)
    setError(null)
    void fetchAuthenticatedAsset(url, bearer)
      .then(async (res) => {
        if (!res.ok) throw new Error(`Could not load (${res.status})`)
        const decoded = await readAuthenticatedTextPreview(res)
        if (alive) setText(decoded)
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      alive = false
    }
  }, [bearer, url])

  if (error) return <Text style={styles.note}>{error}</Text>
  if (text === null) return <Text style={styles.note}>Loading…</Text>
  return (
    <ScrollView
      contentContainerStyle={styles.prose}
      onScrollEndDrag={(event) => {
        if (onPullClose && event.nativeEvent.contentOffset.y < -PULL_CLOSE) onPullClose()
      }}
    >
      {note ? <Text style={styles.clip}>{note}</Text> : null}
      {asMarkdown ? (
        <RichMarkdown text={text} />
      ) : (
        <Text style={styles.mono} selectable>
          {text}
        </Text>
      )}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  // Opaque: the page under the viewer must never show through a document.
  ground: { backgroundColor: color.bg },
  page: { overflow: 'hidden', backgroundColor: color.bg },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingBottom: space.sm,
  },
  cap: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.tertiaryFill,
  },
  capSpace: { width: 44, height: 44 },
  heading: { flex: 1, minWidth: 0, alignItems: 'center' },
  title: {
    ...sans(600),
    color: color.text,
    fontSize: 16,
    lineHeight: 20,
  },
  position: {
    ...mono(400),
    color: color.textDim,
    fontSize: 12,
    lineHeight: 16,
    fontVariant: ['tabular-nums'],
  },
  slide: { flex: 1 },
  dots: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 7,
    paddingTop: space.md,
  },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: color.textFaint },
  dotOn: { backgroundColor: color.text },
  media: {
    width: '100%',
    height: '100%',
  },
  /** Same page the web iframe draws: white, full bleed under the bar. */
  webFrame: {
    flex: 1,
    overflow: 'hidden',
    backgroundColor: '#fff',
  },
  webView: {
    flex: 1,
    backgroundColor: '#fff',
  },
  prose: {
    paddingHorizontal: space.lg,
    paddingBottom: space.xxl,
  },
  /** A caveat about the preview itself — app chrome, never markup injected
   *  into someone else's document. Reads on the white page and on the dark. */
  clip: {
    ...sans(500),
    color: color.textDim,
    fontSize: font.tiny,
    lineHeight: leading(font.tiny),
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    backgroundColor: color.surfaceHigh,
  },
  note: {
    ...sans(400),
    color: color.textDim,
    fontSize: font.small,
    lineHeight: leading(font.small),
    padding: space.lg,
  },
  mono: {
    ...mono(400),
    color: color.body,
    fontSize: font.tiny,
    lineHeight: leading(font.tiny, 'prose'),
  },
})
