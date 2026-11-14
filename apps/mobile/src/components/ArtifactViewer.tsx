import { RequestAnswer } from '@podium/client-graph/request-answer'
import type { IssuePanelArtifact } from '@podium/model'
import { observer } from 'mobx-react-lite'
import { type ComponentType, createElement, useEffect, useMemo, useRef, useState } from 'react'
import {
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
  htmlWithViewport,
  type IssueArtifactPreview,
  issueArtifactLabel,
  issueArtifactPreview,
} from '../lib/issue-artifacts'
import { color, font, leading, mono, sans, space, spring } from '../theme/theme'
import { ArtifactVideo } from './ArtifactVideo'
import { Glass } from './Glass'
import { Icon } from './Icon'
import { type AppIcon, X } from './icons'
import { PressableScale } from './PressableScale'
import { RichMarkdown } from './RichMarkdown'
import { ZoomableImage } from './ZoomableImage'

const HTML_CAP = 2 * 1024 * 1024
/** PDFs are handed to PDFKit whole; past this the phone is the wrong place. */
const PDF_CAP = 40 * 1024 * 1024
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
  /** Runs at document end as a WebKit user script, outside the page's markup. */
  injectedJavaScript?: string
  onMessage?: (event: { nativeEvent: { data: string } }) => void
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

/**
 * The PDFKit page view (modules/podium-pdf), iOS only and resolved lazily like
 * the web view, so the web bundle and tests never touch a native view manager.
 */
type PdfViewComponent = ComponentType<{
  uri: string
  style?: StyleProp<ViewStyle>
  onZoomChange?: (event: { nativeEvent: { zoomed: boolean } }) => void
  onLoadError?: (event: { nativeEvent: { message: string } }) => void
}>
let pdfViewCache: PdfViewComponent | null | undefined
function resolvePdfView(): PdfViewComponent | null {
  if (pdfViewCache === undefined) {
    pdfViewCache = null
    if (Platform.OS === 'ios') {
      try {
        pdfViewCache = (
          require('expo') as { requireNativeView: (name: string) => PdfViewComponent }
        ).requireNativeView('PodiumPdf')
      } catch {
        pdfViewCache = null
      }
    }
  }
  return pdfViewCache
}

/**
 * Reports whether the reader has pinch-zoomed the page past where it opened,
 * so the viewer can hold its pager and pull-to-dismiss still while a pan should
 * move the page. Measured against the opening scale (the page's own fit), not
 * 1, since a page may open zoomed out. Read-only: it never touches the page's
 * zoom limits.
 */
export const HTML_ZOOM_REPORTER = `(function () {
  var v = window.visualViewport, bridge = window.ReactNativeWebView;
  if (!v || !bridge) return;
  var fit = v.scale, zoomed = false;
  v.addEventListener('resize', function () {
    if (v.scale < fit) fit = v.scale;
    var now = v.scale > fit * 1.01;
    if (now === zoomed) return;
    zoomed = now;
    bridge.postMessage(now ? 'podium-zoom:1' : 'podium-zoom:0');
  });
})();
true;`

/** The zoom state an artifact page's message reports, or null for any other
 *  message (the page itself can post to the same bridge). */
export function zoomFromMessage(data: unknown): boolean | null {
  if (data === 'podium-zoom:1') return true
  if (data === 'podium-zoom:0') return false
  return null
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
  // The open page is zoomed past fit: a drag pans it, so neither the pager nor
  // pull-to-dismiss may take one until it is back at fit.
  const [zoomed, setZoomed] = useState(false)
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
    enabled: !zoomed,
    activeOffsetY: 12,
    failOffsetX: [-16, 16],
    // A second finger is a pinch, never a dismiss.
    maxPointers: 1,
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
    if (next !== page && next >= 0 && next < items.length) {
      setPage(next)
      setZoomed(false)
    }
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
            <BarCap label="Close artifact" icon={X} onPress={onClose} />
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
              <BarCap label="Share artifact" icon={ShareIcon} onPress={share} />
            ) : null}
          </Animated.View>
          <ScrollView
            ref={pager}
            horizontal
            pagingEnabled
            scrollEnabled={many && !zoomed}
            testID="artifact-pager"
            showsHorizontalScrollIndicator={false}
            onMomentumScrollEnd={onPage}
            onScroll={Platform.OS === 'web' ? onPage : undefined}
            scrollEventThrottle={64}
            style={styles.fill}
          >
            {items.map((item, at) => (
              <View key={item.key} style={[styles.slide, { width }]}>
                {at === page ? (
                  <ArtifactBody
                    preview={issueArtifactPreview(item.artifact.entry ?? item.artifact.path)}
                    url={item.url}
                    label={issueArtifactLabel(item.artifact)}
                    onPullClose={onClose}
                    onZoomChange={setZoomed}
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

/**
 * A round bar button over the artifact (board Artifact's toolbar caps): the
 * system bar-button shape on the shared Glass piece, since the viewer has no
 * navigation bar to host native ones.
 */
function BarCap({ label, icon, onPress }: { label: string; icon: AppIcon; onPress: () => void }) {
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={styles.cap}
    >
      <Glass interactive tintColor={color.fill} style={styles.capGlass}>
        <Icon as={icon} size={18} color={color.text} />
      </Glass>
    </PressableScale>
  )
}

function ArtifactBody({
  preview,
  url,
  label,
  onPullClose,
  onZoomChange,
}: {
  preview: IssueArtifactPreview
  url: string | null
  label: string
  onPullClose: () => void
  /** The page left fit (true) or came back to it (false). */
  onZoomChange: (zoomed: boolean) => void
}) {
  const { bearer } = useServerProfile()
  if (!url) {
    return <Text style={styles.note}>This file is not reachable from this phone.</Text>
  }
  if (preview === 'image') {
    return (
      <ZoomableImage
        source={authenticatedImageSource(url, bearer)}
        label={label}
        onZoomChange={onZoomChange}
      />
    )
  }
  if (preview === 'video') {
    return <ArtifactVideo url={url} bearer={bearer} label={label} />
  }
  if (preview === 'html' || preview === 'pdf') {
    if (Platform.OS === 'web') {
      // The browser's own page and PDF viewers zoom themselves.
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
    if (preview === 'pdf') return <PdfPages url={url} bearer={bearer} onZoomChange={onZoomChange} />
    return <HtmlWebView url={url} bearer={bearer} onZoomChange={onZoomChange} />
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
const HtmlWebView = observer(function HtmlWebView({
  url,
  bearer,
  onZoomChange,
}: {
  url: string
  bearer: string | null
  onZoomChange: (zoomed: boolean) => void
}) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: selection and credentials own this request lifetime.
  const request = useMemo(
    () => new RequestAnswer<{ uri: string; clipped: boolean }>(),
    [url, bearer],
  )
  const [terminated, setTerminated] = useState(false)
  const WebView = resolveDomWebView()
  useEffect(() => {
    setTerminated(false)
    if (!WebView) return
    void request.load(async () => {
      const res = await fetchAuthenticatedAsset(url, bearer)
      if (!res.ok) throw new Error(`Could not load (${res.status})`)
      const buf = await res.arrayBuffer()
      const clipped = buf.byteLength > HTML_CAP
      const decoded = new TextDecoder().decode(clipped ? buf.slice(0, HTML_CAP) : buf)
      const html = clipped ? endAtTagBoundary(decoded) : decoded
      return { uri: htmlDataUri(htmlWithViewport(htmlWithBase(html, url))), clipped }
    })
    return () => request.close()
  }, [request, bearer, url, WebView])
  const error = terminated
    ? 'The phone stopped this preview — the page is too heavy to render here.'
    : request.error
  const doc = request.answer
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
  if (doc === undefined) return <Text style={styles.note}>Loading…</Text>
  return (
    <View style={styles.webFrame} testID="artifact-html-webview">
      {doc.clipped ? (
        <Text style={styles.clip}>
          Preview clipped at {Math.round(HTML_CAP / (1024 * 1024))} MB — open it on a desktop to
          read the rest.
        </Text>
      ) : null}
      <WebView
        source={{ uri: doc.uri }}
        style={styles.webView}
        // A blank frame is the one failure a reader cannot interpret. iOS kills
        // the WebContent process on a heavy page (far sooner on a phone than in
        // the simulator), and the view is left showing nothing at all; say so.
        onContentProcessDidTerminate={() => setTerminated(true)}
        // WebKit's own pinch zoom, within whatever limits the page declares.
        injectedJavaScript={HTML_ZOOM_REPORTER}
        onMessage={(event) => {
          const zoomed = zoomFromMessage(event.nativeEvent.data)
          if (zoomed !== null) onZoomChange(zoomed)
        }}
      />
    </View>
  )
})

/** The slice of expo-file-system the PDF hand-off uses. */
interface CacheFile {
  readonly uri: string
  readonly exists: boolean
  create(options?: { overwrite?: boolean }): void
  write(content: Uint8Array): void
  delete(): void
}
interface CacheFiles {
  File: new (directory: unknown, name: string) => CacheFile
  Paths: { cache: unknown }
}

/**
 * A PDF on PDFKit (modules/podium-pdf): multipage, fitted to the width, and
 * zoomable from fit to 5×, with the double tap PDF readers use. The bytes come
 * down the authenticated fetch path into a cache file PDFKit opens, and the
 * file goes again when the page closes. A binary without the module says so
 * rather than showing the PDF's bytes as text.
 */
const PdfPages = observer(function PdfPages({
  url,
  bearer,
  onZoomChange,
}: {
  url: string
  bearer: string | null
  onZoomChange: (zoomed: boolean) => void
}) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: selection and credentials own this request lifetime.
  const request = useMemo(() => new RequestAnswer<string>(), [url, bearer])
  const [failed, setFailed] = useState<string | null>(null)
  const PdfView = resolvePdfView()
  useEffect(() => {
    setFailed(null)
    if (!PdfView) return
    let closed = false
    let written: CacheFile | null = null
    const discard = () => {
      try {
        if (written?.exists) written.delete()
      } catch {}
    }
    void request.load(async () => {
      const res = await fetchAuthenticatedAsset(url, bearer)
      if (!res.ok) throw new Error(`Could not load (${res.status})`)
      const bytes = new Uint8Array(await res.arrayBuffer())
      if (bytes.byteLength > PDF_CAP) {
        throw new Error(
          `This PDF is over ${Math.round(PDF_CAP / (1024 * 1024))} MB — open it on a desktop.`,
        )
      }
      // Lazily, like the views: the web bundle and the tests never load it.
      const { File, Paths } = require('expo-file-system') as CacheFiles
      const file = new File(Paths.cache, `artifact-${Date.now().toString(36)}.pdf`)
      file.create({ overwrite: true })
      file.write(bytes)
      written = file
      // Closed while the bytes were still coming: nothing will show this file.
      if (closed) discard()
      return file.uri
    })
    return () => {
      closed = true
      request.close()
      discard()
    }
  }, [request, bearer, url, PdfView])
  if (!PdfView) return <Text style={styles.note}>This build cannot show PDFs.</Text>
  const error = failed ?? request.error
  if (error) return <Text style={styles.note}>{error}</Text>
  if (request.answer === undefined) return <Text style={styles.note}>Loading…</Text>
  return (
    <PdfView
      uri={request.answer}
      style={styles.fill}
      onZoomChange={(event) => onZoomChange(event.nativeEvent.zoomed)}
      onLoadError={(event) => setFailed(event.nativeEvent.message)}
    />
  )
})

const FetchedText = observer(function FetchedText({
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: selection and credentials own this request lifetime.
  const request = useMemo(() => new RequestAnswer<string>(), [url, bearer])
  useEffect(() => {
    void request.load(async () => {
      const res = await fetchAuthenticatedAsset(url, bearer)
      if (!res.ok) throw new Error(`Could not load (${res.status})`)
      return readAuthenticatedTextPreview(res)
    })
    return () => request.close()
  }, [request, bearer, url])
  const { answer: text, error } = request

  if (error) return <Text style={styles.note}>{error}</Text>
  if (text === undefined) return <Text style={styles.note}>Loading…</Text>
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
})

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
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    // Under the glass: clear Liquid Glass over a white document page all but
    // vanished in light mode; the system fill gives the disc its edge.
    backgroundColor: color.secondaryFill,
    // The web Modal focuses its first control on open, and the browser drew
    // its focus ring round the close button: the white ring.
    ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : null),
  },
  capGlass: {
    ...StyleSheet.absoluteFill,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Leading, beside the close button (board Artifact).
  heading: { flex: 1, minWidth: 0, alignItems: 'flex-start' },
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
