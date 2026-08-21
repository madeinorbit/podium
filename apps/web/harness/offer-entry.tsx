/**
 * THE AGENT OFFER, PHOTOGRAPHED IN ITS TWO HOSTS (POD-1462).
 *
 * `OfferBar.test.tsx` proves the bar's behaviour; it cannot say anything about
 * the two things this harness exists for, because both are pure CSS that jsdom
 * never applies:
 *
 *   1. how far the signal badge sits from the surface's own left edge, and
 *      whether the offer shares a left margin with the composer under it;
 *   2. whether the secondary actions read as controls or as loose text.
 *
 * So the shipping component is mounted against the real stylesheet inside a
 * faithful copy of each host's wrapper chain — the chat composer's dock (its
 * 22px gutter and its rounded well) and the native pane's offer dock (10px, on
 * the app ground) — with the transcript sheet above it, because the sheet's
 * edge is the line the badge is judged against.
 *
 * `window.probe`:
 *   .theme('dark' | 'light')     swap the two shipping appearances
 *   .expand(true | false)        the fold, which is where the actions live
 *   .width(px)                   drive the container query (560px fallback)
 */
import type { SessionMeta, SessionOffer } from '@podium/model/browser'
import { type JSX, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { OfferBar } from '@/features/chat/OfferBar'
import '@/index.css'
import '@/styles.css'

declare global {
  interface Window {
    probe: {
      theme: (t: 'dark' | 'light') => void
      expand: (open: boolean) => void
      width: (px: number) => void
    }
  }
}

/** The offer from the screenshot this issue opened with: a headline, two lines
 *  of detail, curated evidence, one recommendation, and two alternatives — one
 *  of which collects feedback. */
const OFFER: SessionOffer = {
  message: [
    'Light sidebar rows now read as colours, not smudges.',
    'Issue tint on the paper work row goes from ~2.8% to ~4.2% resting (hover ~4.4% → ~6.6%) via a new row-only scale; dark is untouched and the deck/tab-strip surfaces stay where POD-725 put them.',
    'The one thing to judge is the dose — the sweep artifact shows 0.4 / 0.5 / 0.6 / 0.7% side by side.',
  ].join('\n'),
  actions: [
    { label: 'Merge it', prompt: 'Merge it.' },
    { label: 'Try 0.7%', prompt: 'Try the 0.7% dose instead.' },
    { label: 'Send back', prompt: 'Send this back.', input: true },
  ],
  artifacts: ['docs/sweep-a.png', 'docs/sweep-b.png'],
  createdAt: '2026-08-21T09:05:00.000Z',
}

const SESSION = {
  sessionId: 'sess_1',
  issueId: 'iss_1462',
  lastInputAt: '2026-08-21T08:00:00.000Z',
} as unknown as SessionMeta

function Bar({ expanded }: { expanded: boolean }): JSX.Element {
  // The bar owns its own fold, and the probe drives it through the disclosure —
  // clicking the real control is the only way to get the real transition.
  return (
    <OfferBar
      key={expanded ? 'open' : 'shut'}
      offer={OFFER}
      disabled={false}
      onAction={async () => {}}
      onDismiss={async () => {}}
      session={SESSION}
    />
  )
}

/** The chat composer's chain: transcript sheet › dock (22px gutter) › the
 *  offer, with the composer's own rounded well beneath it. */
function ChatHost({ expanded }: { expanded: boolean }): JSX.Element {
  return (
    <div className="workspace-sheet flex flex-col overflow-hidden rounded-[12px] bg-card">
      <div className="px-[max(32px,calc((100%-888px)/2))] pt-5 pb-2">
        <p className="text-[13.5px] leading-[1.6] text-foreground">
          Landed the row-only tint scale and swept the dose. Everything below the sidebar row is
          untouched.
        </p>
      </div>
      <div className="offer-lift-seat chat-composer-dock px-[22px] pt-2 pb-[18px]">
        <div className="mb-2">
          <Bar expanded={expanded} />
        </div>
        <div className="chat-composer-well flex flex-col gap-1.5 rounded-[12px] pt-[11px] pr-3 pb-[9px] pl-[15px]">
          <span className="text-[14px] leading-[24px] text-muted-foreground">
            Message — resumes the agent…
          </span>
          <div className="composer-row">
            <span className="size-7 rounded-[8px] bg-chip" />
          </div>
        </div>
      </div>
    </div>
  )
}

/** The native pane's chain: the PTY above, then the dock the offer arrives on
 *  — its own surface, 10px of gutter, a seam at the top. */
function NativeHost({ expanded }: { expanded: boolean }): JSX.Element {
  return (
    <div className="workspace-sheet flex flex-col overflow-hidden rounded-[12px] bg-card">
      <div className="bg-background px-3 py-4 font-mono text-[10.5px] leading-[1.7] text-text-dim">
        <div>$ bun run test:web src/features/worklist</div>
        <div> 46 pass · 0 fail</div>
      </div>
      <div className="offer-lift-seat">
        <div className="offer-dock-inner" style={{ transform: 'none', opacity: 1 }}>
          <Bar expanded={expanded} />
        </div>
      </div>
    </div>
  )
}

function Harness(): JSX.Element {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')
  const [expanded, setExpanded] = useState(true)
  const [width, setWidth] = useState(920)

  useEffect(() => {
    window.probe = { theme: setTheme, expand: setExpanded, width: setWidth }
  }, [])

  useEffect(() => {
    // The shipping mechanism: ONE theme attribute, and `.dark` is what picks
    // Dark Ink over Paper. A `data-theme="paper"` matches no rule at all and
    // renders the unthemed fallback, which looks like a broken light mode.
    document.documentElement.setAttribute('data-theme', 'podium')
    document.documentElement.classList.toggle('dark', theme === 'dark')
    document.body.style.background = 'var(--background)'
  }, [theme])

  // The fold is the bar's own state; the probe reaches it through the real
  // disclosure button so the measured height is the one the transition lands on.
  useEffect(() => {
    for (const el of document.querySelectorAll<HTMLButtonElement>(
      '[data-testid="offer-disclosure"]',
    )) {
      const root = el.closest('[data-testid="offer-bar"]')
      const open = root?.classList.contains('offer-fold-root--expanded') ?? false
      if (open !== expanded) el.click()
    }
  }, [expanded])

  return (
    <div className="min-h-screen bg-background p-8 font-sans">
      <div className="mx-auto flex flex-col gap-8" style={{ width, maxWidth: '100%' }}>
        <div>
          <div className="mb-2 font-mono text-[10px] tracking-[0.13em] text-text-faint uppercase">
            chat composer · 22px gutter
          </div>
          <ChatHost expanded={expanded} />
        </div>
        <div>
          <div className="mb-2 font-mono text-[10px] tracking-[0.13em] text-text-faint uppercase">
            native dock · 10px gutter
          </div>
          <NativeHost expanded={expanded} />
        </div>
      </div>
    </div>
  )
}

const root = document.getElementById('root')
if (root) createRoot(root).render(<Harness />)
