import type { TranscriptItem } from '@podium/protocol'
import DOMPurify from 'dompurify'
import { ChevronDown, ChevronUp, FileText, Image as ImageIcon, Mic, Send } from 'lucide-react'
import { marked } from 'marked'
import type { JSX } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  blockMatches,
  type ChatBlock,
  minimapSegments,
  pairToolResults,
  searchBlocks,
} from './chat'
import { useStore } from './store'
import { useVoiceInput } from './voice'

marked.setOptions({ gfm: true, breaks: true })

function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(marked.parse(text, { async: false }))
}

/**
 * Claude-app-style chat rendering of a session's structured transcript, with a
 * native write-through input, quick transcript search, and a Sublime-style
 * birds-eye minimap (user prompts highlighted; click scrolls).
 */
export function ChatView({ sessionId }: { sessionId: string }): JSX.Element {
  const { hub, trpc, sessions } = useStore()
  const session = sessions.find((s) => s.sessionId === sessionId)
  const [items, setItems] = useState<TranscriptItem[]>([])
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')
  const [matchCursor, setMatchCursor] = useState(0)
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const pinnedToBottom = useRef(true)
  const voice = useVoiceInput((text) => setDraft((d) => (d ? `${d} ${text}` : text)))

  useEffect(() => hub.subscribeTranscript(sessionId, setItems), [hub, sessionId])

  const blocks = useMemo(() => pairToolResults(items), [items])
  const matches = useMemo(() => searchBlocks(blocks, query), [blocks, query])
  const activeMatch = matches.length > 0 ? matches[matchCursor % matches.length] : undefined

  // Follow the live tail unless the user scrolled up to read.
  useEffect(() => {
    const el = scrollerRef.current
    if (el && pinnedToBottom.current) el.scrollTop = el.scrollHeight
  }, [])
  const onScroll = () => {
    const el = scrollerRef.current
    if (!el) return
    pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  const scrollToBlock = (index: number) => {
    scrollerRef.current
      ?.querySelector(`[data-block="${index}"]`)
      ?.scrollIntoView({ block: 'center' })
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: scrolling is the effect of cursor moves
  useEffect(() => {
    if (activeMatch !== undefined) scrollToBlock(activeMatch)
  }, [activeMatch])

  const send = async () => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    pinnedToBottom.current = true
    await trpc.sessions.sendText.mutate({ sessionId, text }).catch(() => {})
  }

  const sendable = session?.status === 'live' || session?.status === 'starting'

  return (
    <div className="chat-view">
      <div className="chat-search">
        <input
          type="text"
          placeholder="Search transcript…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setMatchCursor(0)
          }}
        />
        {query && (
          <span className="chat-search-meta">
            {matches.length === 0
              ? '0'
              : `${(matchCursor % Math.max(1, matches.length)) + 1}/${matches.length}`}
            <button
              type="button"
              title="Previous match"
              onClick={() =>
                setMatchCursor((c) => (c - 1 + matches.length) % Math.max(1, matches.length))
              }
            >
              <ChevronUp size={13} aria-hidden="true" />
            </button>
            <button
              type="button"
              title="Next match"
              onClick={() => setMatchCursor((c) => (c + 1) % Math.max(1, matches.length))}
            >
              <ChevronDown size={13} aria-hidden="true" />
            </button>
          </span>
        )}
      </div>
      <div className="chat-body">
        <div className="chat-scroll" ref={scrollerRef} onScroll={onScroll}>
          {blocks.length === 0 && (
            <div className="chat-empty">
              No transcript yet. For Claude sessions the feed starts with the first prompt; shells
              and Codex sessions have no structured transcript (yet).
            </div>
          )}
          {blocks.map((block, i) => (
            <ChatBlockView
              key={block.item.id}
              block={block}
              index={i}
              highlighted={i === activeMatch}
              dimmed={query.trim() !== '' && !blockMatches(block, query)}
            />
          ))}
        </div>
        <Minimap blocks={blocks} scrollerRef={scrollerRef} onJump={scrollToBlock} />
      </div>
      <div className="chat-input">
        <textarea
          rows={Math.min(6, Math.max(1, draft.split('\n').length))}
          placeholder={
            sendable
              ? 'Message the agent… (Enter to send, Shift+Enter for newline)'
              : 'Session is not running.'
          }
          value={draft}
          disabled={!sendable}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
        />
        {voice.supported && (
          <button
            type="button"
            className={voice.listening ? 'chat-mic active' : 'chat-mic'}
            title={voice.listening ? 'Stop voice input' : 'Voice input'}
            onClick={voice.toggle}
          >
            <Mic size={15} aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          className="chat-send"
          disabled={!sendable || !draft.trim()}
          title="Send"
          onClick={() => void send()}
        >
          <Send size={15} aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}

function ChatBlockView({
  block,
  index,
  highlighted,
  dimmed,
}: {
  block: ChatBlock
  index: number
  highlighted: boolean
  dimmed: boolean
}): JSX.Element | null {
  const { item } = block
  const cls = [
    'chat-block',
    `chat-${item.role}`,
    highlighted ? 'match-active' : '',
    dimmed ? 'dimmed' : '',
  ]
    .filter(Boolean)
    .join(' ')

  if (item.role === 'tool') return <ToolBlock block={block} cls={cls} index={index} />

  return (
    <div className={cls} data-block={index}>
      {item.role === 'user' && <div className="chat-role-tag">You</div>}
      {item.role === 'system' && <div className="chat-role-tag">System</div>}
      <div
        className="chat-md"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized by DOMPurify above
        dangerouslySetInnerHTML={{ __html: renderMarkdown(item.text) }}
      />
      {item.tags && item.tags.length > 0 && (
        <div className="chat-tags">
          {item.tags.map((tag, i) => (
            <span key={`${tag.kind}-${i}`} className="chat-tag">
              {tag.kind === 'image' ? (
                <ImageIcon size={12} aria-hidden="true" />
              ) : (
                <FileText size={12} aria-hidden="true" />
              )}
              {tag.label ?? tag.kind}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function ToolBlock({
  block,
  cls,
  index,
}: {
  block: ChatBlock
  cls: string
  index: number
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const { item } = block
  const result = block.result ?? item.toolResult
  // Orphan results render as a bare result row; calls render name + input.
  const label = item.toolName ?? 'result'
  return (
    <div className={cls} data-block={index}>
      <button type="button" className="chat-tool-row" onClick={() => setOpen((v) => !v)}>
        <span className="chat-tool-chevron">{open ? '▾' : '▸'}</span>
        <span className="chat-tool-name">{label}</span>
        {item.toolInput && <span className="chat-tool-input">{item.toolInput}</span>}
      </button>
      {open && <pre className="chat-tool-result">{result ?? '(no result captured)'}</pre>}
    </div>
  )
}

/**
 * Birds-eye strip: one slab per block, log-weighted by length; user prompts
 * pop in accent so "where did I steer" reads at a glance. A viewport box
 * mirrors the scroll position; clicking anywhere jumps there.
 */
function Minimap({
  blocks,
  scrollerRef,
  onJump,
}: {
  blocks: ChatBlock[]
  scrollerRef: React.RefObject<HTMLDivElement | null>
  onJump: (index: number) => void
}): JSX.Element | null {
  const segments = useMemo(() => minimapSegments(blocks), [blocks])
  const [viewport, setViewport] = useState({ top: 0, height: 1 })

  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const update = () => {
      const total = el.scrollHeight || 1
      setViewport({ top: el.scrollTop / total, height: el.clientHeight / total })
    }
    update()
    el.addEventListener('scroll', update, { passive: true })
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', update)
      ro.disconnect()
    }
  }, [scrollerRef])

  if (segments.length < 2) return null
  const totalWeight = segments.reduce((sum, s) => sum + s.weight, 0)
  return (
    <div className="chat-minimap" role="presentation">
      {segments.map((seg) => (
        <button
          key={seg.index}
          type="button"
          className={`mm-seg mm-${seg.role}`}
          style={{ height: `${(seg.weight / totalWeight) * 100}%` }}
          title={blocks[seg.index]?.item.text.slice(0, 80) || blocks[seg.index]?.item.toolName}
          onClick={() => onJump(seg.index)}
        />
      ))}
      <div
        className="mm-viewport"
        style={{
          top: `${viewport.top * 100}%`,
          height: `${Math.max(0.04, viewport.height) * 100}%`,
        }}
      />
    </div>
  )
}
