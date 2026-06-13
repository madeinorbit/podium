import { Eraser, Mic, Send, Sparkles } from 'lucide-react'
import type { JSX } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { reposToViews } from './derive'
import { renderMarkdown } from './markdown'
import { useStore } from './store'
import { useConversationSearch } from './useConversationSearch'
import { useVoiceInput } from './voice'

interface SuperMessage {
  id: number
  role: 'user' | 'assistant' | 'tool' | 'system'
  content: string
  toolCalls?: { id: string; name: string; arguments: string }[]
  toolCallId?: string
  toolName?: string
  createdAt: string
}

interface AtOption {
  kind: 'repo' | 'worktree' | 'conversation'
  label: string
  detail: string
  /** What lands in the input: @label(ref). */
  ref: string
}

/**
 * The superagent: an orchestrator chat with cross-project context and tools.
 * `@` in the input opens the context menu — repos, worktrees, conversations
 * (files later) — and inserts an @label(ref) token the agent understands.
 */
export function SuperagentView(): JSX.Element {
  const { trpc, repos } = useStore()
  const [messages, setMessages] = useState<SuperMessage[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [backendLabel, setBackendLabel] = useState('')
  const [atQuery, setAtQuery] = useState<string | null>(null)
  const [atIndex, setAtIndex] = useState(0)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const voice = useVoiceInput((text) => setDraft((d) => (d ? `${d} ${text}` : text)))

  useEffect(() => {
    trpc.superagent.history
      .query()
      .then((h) => setMessages(h as SuperMessage[]))
      .catch(() => {})
  }, [trpc])

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll follows new messages
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, busy])

  // ---- @ context menu ----
  const localAtOptions = useMemo<AtOption[]>(() => {
    const views = reposToViews(repos)
    const out: AtOption[] = []
    for (const repo of views) {
      out.push({ kind: 'repo', label: repo.name, detail: repo.path, ref: repo.path })
      for (const wt of repo.worktrees) {
        if (wt.isMain) continue
        out.push({
          kind: 'worktree',
          label: `${repo.name}/${wt.branch ?? wt.path.split('/').pop()}`,
          detail: wt.path,
          ref: wt.path,
        })
      }
    }
    return out
  }, [repos])

  // Conversations join the @-menu async via the shared (race-guarded) search;
  // files come later. The menu is derived, not stored, so a slow stale response
  // can't overwrite the current query's options.
  const { hits: convHits } = useConversationSearch({
    query: atQuery ?? '',
    limit: 4,
    enabled: atQuery !== null,
    debounceMs: 150,
  })
  const atHits = useMemo<AtOption[]>(() => {
    if (atQuery === null) return []
    const q = atQuery.toLowerCase()
    const local = localAtOptions
      .filter((o) => o.label.toLowerCase().includes(q) || o.detail.toLowerCase().includes(q))
      .slice(0, 6)
    const convs = convHits.map(
      (hit): AtOption => ({
        kind: 'conversation',
        label: hit.name || hit.title || hit.id,
        detail: hit.projectPath?.split('/').slice(-2).join('/') ?? '',
        ref: `conversation:${hit.id}`,
      }),
    )
    return [...local, ...convs].slice(0, 10)
  }, [atQuery, localAtOptions, convHits])
  // Keep the highlighted index in range as the option list changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on query change
  useEffect(() => setAtIndex(0), [atQuery])

  const syncAtState = (value: string, caret: number) => {
    // An @-mention is active when the text before the caret ends in @word.
    const before = value.slice(0, caret)
    const match = /(?:^|\s)@([\w./-]*)$/.exec(before)
    setAtQuery(match ? (match[1] ?? '') : null)
  }

  const insertAt = (option: AtOption) => {
    const el = inputRef.current
    const caret = el?.selectionStart ?? draft.length
    const before = draft.slice(0, caret).replace(/@([\w./-]*)$/, '')
    const token = `@${option.label}(${option.ref}) `
    setDraft(before + token + draft.slice(caret))
    setAtQuery(null)
    el?.focus()
  }

  const send = async () => {
    const text = draft.trim()
    if (!text || busy) return
    setDraft('')
    setAtQuery(null)
    setBusy(true)
    // Optimistic local echo; the server returns the persisted turn.
    const optimistic: SuperMessage = {
      id: -Date.now(),
      role: 'user',
      content: text,
      createdAt: new Date().toISOString(),
    }
    setMessages((m) => [...m, optimistic])
    try {
      const turn = (await trpc.superagent.send.mutate({ text })) as {
        messages: SuperMessage[]
        backendLabel: string
      }
      setBackendLabel(turn.backendLabel)
      setMessages((m) => [...m.filter((x) => x.id !== optimistic.id), ...turn.messages])
    } catch (e) {
      setMessages((m) => [
        ...m,
        {
          id: -Date.now() - 1,
          role: 'assistant',
          content: `Request failed: ${e instanceof Error ? e.message : String(e)}`,
          createdAt: new Date().toISOString(),
        },
      ])
    } finally {
      setBusy(false)
    }
  }

  const clear = async () => {
    await trpc.superagent.clear.mutate().catch(() => {})
    setMessages([])
  }

  return (
    <section className="superagent">
      <div className="superagent-head">
        <h1>
          <Sparkles size={16} aria-hidden="true" /> Superagent
        </h1>
        <span className="superagent-backend">{backendLabel}</span>
        <button type="button" title="Clear thread" onClick={() => void clear()}>
          <Eraser size={14} aria-hidden="true" />
        </button>
      </div>
      <div className="superagent-scroll" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="chat-empty">
            Your orchestrator. Ask it to start agents, set up worktrees, dig through past
            conversations, or work tickets. Type <code>@</code> to reference a repo, worktree, or
            conversation.
          </div>
        )}
        {messages.map((m) => (
          <SuperMessageView key={m.id} message={m} />
        ))}
        {busy && <div className="superagent-busy">Thinking…</div>}
      </div>
      <div className="chat-input">
        <div className="superagent-input-wrap">
          {atQuery !== null && atHits.length > 0 && (
            <div className="at-menu" role="listbox">
              {atHits.map((option, i) => (
                <button
                  key={`${option.kind}-${option.ref}`}
                  type="button"
                  role="option"
                  aria-selected={i === atIndex}
                  className={i === atIndex ? 'at-option active' : 'at-option'}
                  onMouseEnter={() => setAtIndex(i)}
                  onClick={() => insertAt(option)}
                >
                  <span className="at-kind">{option.kind}</span>
                  <span className="at-label">{option.label}</span>
                  <span className="at-detail">{option.detail}</span>
                </button>
              ))}
              <div className="at-note">files: coming later</div>
            </div>
          )}
          <textarea
            ref={inputRef}
            rows={Math.min(6, Math.max(1, draft.split('\n').length))}
            placeholder="Orchestrate… (@ for context, Enter to send)"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value)
              syncAtState(e.target.value, e.target.selectionStart ?? e.target.value.length)
            }}
            onKeyDown={(e) => {
              if (atQuery !== null && atHits.length > 0) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setAtIndex((i) => (i + 1) % atHits.length)
                  return
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setAtIndex((i) => (i - 1 + atHits.length) % atHits.length)
                  return
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault()
                  const pick = atHits[atIndex]
                  if (pick) insertAt(pick)
                  return
                }
                if (e.key === 'Escape') {
                  setAtQuery(null)
                  return
                }
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send()
              }
            }}
          />
        </div>
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
          disabled={busy || !draft.trim()}
          title="Send"
          onClick={() => void send()}
        >
          <Send size={15} aria-hidden="true" />
        </button>
      </div>
    </section>
  )
}

function SuperMessageView({ message }: { message: SuperMessage }): JSX.Element | null {
  const [open, setOpen] = useState(false)
  if (message.role === 'tool') {
    return (
      <div className="chat-block chat-tool">
        <button type="button" className="chat-tool-row" onClick={() => setOpen((v) => !v)}>
          <span className="chat-tool-chevron">{open ? '▾' : '▸'}</span>
          <span className="chat-tool-name">{message.toolName ?? 'tool'}</span>
          <span className="chat-tool-input">result</span>
        </button>
        {open && <pre className="chat-tool-result">{message.content}</pre>}
      </div>
    )
  }
  if (message.role === 'system') return null
  return (
    <div className={`chat-block chat-${message.role}`}>
      {message.role === 'user' && <div className="chat-role-tag">You</div>}
      {message.content && (
        <div
          className="chat-md"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized by DOMPurify
          dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }}
        />
      )}
      {message.toolCalls && message.toolCalls.length > 0 && (
        <div className="superagent-calls">
          {message.toolCalls.map((c) => (
            <span key={c.id} className="superagent-call">
              ⚙ {c.name}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
