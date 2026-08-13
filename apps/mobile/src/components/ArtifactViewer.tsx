import type { IssuePanelArtifact } from '@podium/model'
import { X } from 'lucide-react-native'
import { createElement, useEffect, useState } from 'react'
import { Image, Modal, Platform, ScrollView, StyleSheet, Text, View } from 'react-native'
import {
  type IssueArtifactPreview,
  issueArtifactLabel,
  issueArtifactPreview,
} from '../lib/issue-artifacts'
import { color, font, leading, mono, radius, sans, space } from '../theme/theme'
import { Icon } from './Icon'
import { PressableScale } from './PressableScale'
import { RichMarkdown } from './RichMarkdown'

const TEXT_CAP = 512 * 1024

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
  if (!url) {
    return <Text style={styles.note}>This file is not reachable from this phone.</Text>
  }
  if (preview === 'image') {
    return <Image source={{ uri: url }} style={styles.media} resizeMode="contain" accessibilityLabel={label} />
  }
  if (preview === 'video') {
    if (Platform.OS === 'web') {
      return createElement('video', {
        src: url,
        controls: true,
        autoPlay: true,
        style: { width: '100%', height: '100%', backgroundColor: '#000' },
      })
    }
    return <Text style={styles.note}>Video preview needs the web app.</Text>
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
    return <FetchedText url={url} asMarkdown={false} />
  }
  if (preview === 'markdown') return <FetchedText url={url} asMarkdown />
  if (preview === 'text') return <FetchedText url={url} asMarkdown={false} />
  return <FetchedText url={url} asMarkdown={false} />
}

function FetchedText({ url, asMarkdown }: { url: string; asMarkdown: boolean }) {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setText(null)
    setError(null)
    void fetch(url, { credentials: 'include' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Could not load (${res.status})`)
        const buf = await res.arrayBuffer()
        const slice = buf.byteLength > TEXT_CAP ? buf.slice(0, TEXT_CAP) : buf
        const decoded = new TextDecoder().decode(slice)
        if (alive) setText(decoded)
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      alive = false
    }
  }, [url])

  if (error) return <Text style={styles.note}>{error}</Text>
  if (text === null) return <Text style={styles.note}>Loading…</Text>
  if (asMarkdown) {
    return (
      <ScrollView contentContainerStyle={styles.prose}>
        <RichMarkdown text={text} />
      </ScrollView>
    )
  }
  return (
    <ScrollView contentContainerStyle={styles.prose}>
      <Text style={styles.mono} selectable>
        {text}
      </Text>
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
  prose: {
    paddingBottom: space.xxl,
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
