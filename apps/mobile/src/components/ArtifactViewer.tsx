import type { IssuePanelArtifact } from '@podium/model'
import { type ComponentType, createElement, useEffect, useState } from 'react'
import { X } from './icons'
import {
  Image,
  Modal,
  Platform,
  ScrollView,
  type StyleProp,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from 'react-native'
import {
  authenticatedImageSource,
  fetchAuthenticatedAsset,
  readAuthenticatedTextPreview,
} from '../client/authenticated-assets'
import { useServerProfile } from '../client/ServerProfileGate'
import {
  endAtTagBoundary,
  htmlDataUri,
  htmlWithBase,
  type IssueArtifactPreview,
  issueArtifactLabel,
  issueArtifactPreview,
} from '../lib/issue-artifacts'
import { color, font, leading, mono, radius, sans, space } from '../theme/theme'
import { ArtifactVideo } from './ArtifactVideo'
import { Icon } from './Icon'
import { PressableScale } from './PressableScale'
import { RichMarkdown } from './RichMarkdown'

const HTML_CAP = 2 * 1024 * 1024

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
/**
 * In-app issue artifact viewer. Images and video stay in a lightbox; HTML
 * concepts render in a same-origin frame; markdown and text are fetched and
 * shown here. Leaving the PWA via Linking.openURL dropped the session cookie
 * and made artifacts unreadable on the phone.
 */
export function ArtifactViewer({
  artifact,
  url,
  onClose,
}: {
  artifact: IssuePanelArtifact | null
  url: string | null
  onClose: () => void
}) {
  if (!artifact) return null
  const preview = issueArtifactPreview(artifact.entry ?? artifact.path)
  const label = issueArtifactLabel(artifact)

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.shell} testID="artifact-viewer">
        <View style={styles.bar}>
          <Text style={styles.title} numberOfLines={1}>
            {label}
          </Text>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Close artifact"
            onPress={onClose}
            hitSlop={10}
            style={styles.close}
          >
            <Icon as={X} size={18} color={color.text} />
          </PressableScale>
        </View>
        <View style={styles.body}>
          <ArtifactBody preview={preview} url={url} label={label} />
        </View>
      </View>
    </Modal>
  )
}

function ArtifactBody({
  preview,
  url,
  label,
}: {
  preview: IssueArtifactPreview
  url: string | null
  label: string
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
          borderRadius: 8,
        },
      })
    }
    return <HtmlWebView url={url} bearer={bearer} />
  }
  if (preview === 'markdown') return <FetchedText url={url} asMarkdown bearer={bearer} />
  if (preview === 'text') return <FetchedText url={url} asMarkdown={false} bearer={bearer} />
  return <FetchedText url={url} asMarkdown={false} bearer={bearer} />
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
}: {
  url: string
  asMarkdown: boolean
  bearer: string | null
  /** Why this is source text rather than the rendered thing, when it is. */
  note?: string
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
    <ScrollView contentContainerStyle={styles.prose}>
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
  shell: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.94)',
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingTop: 52,
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
  },
  title: {
    ...sans(600),
    flex: 1,
    color: color.text,
    fontSize: font.small,
  },
  close: {
    width: 36,
    height: 36,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.surfaceHigh,
  },
  body: {
    flex: 1,
    paddingHorizontal: space.md,
    paddingBottom: space.xl,
  },
  media: {
    width: '100%',
    height: '100%',
  },
  /** Same shape the web iframe draws: white page, rounded, clipped. */
  webFrame: {
    flex: 1,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#fff',
  },
  webView: {
    flex: 1,
    backgroundColor: '#fff',
  },
  prose: {
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
