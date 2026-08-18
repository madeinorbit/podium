import { ArrowRight, ChevronRight, RotateCw } from 'lucide-react'
import { type JSX, type ReactNode, useEffect, useState } from 'react'
import { AsciiWordmark } from '@/features/setup/podium-wordmark'

/**
 * THE ONE SCREEN PODIUM SHOWS WHEN IT CANNOT SHOW YOUR WORK.
 *
 * Four screens used to say this in four ways: the setup gate's recovery console,
 * the boot gate's bare yellow rule, the connect failure, and the render-crash
 * boundary. Same moment, same reader, same decision — so one composition, and the
 * caller supplies only what is true of its own fault [POD-1304].
 *
 * It reads left to right as a sentence and then an instrument: the wordmark says
 * which product stopped, the headline says what happened in the operator's own
 * language, and the console on the right is the machine's account of it — what it
 * asked, of whom, what came back, and the exact fault text for whoever will file
 * the bug.
 *
 * ON THEME TOKENS, NOT FIXED INK. The login screen is deliberately theme-
 * independent because it is one designed moment before the product exists. These
 * are not: `ErrorBoundary` renders this over a running app, and a black slab
 * dropped on an operator working in Paper is a second shock on top of the first.
 */

export interface BootTrace {
  /** This end of the link — always the side that is still working. */
  readonly from: string
  /** The far end, the one that failed. */
  readonly to: string
}

export interface BootField {
  readonly label: string
  readonly value: string
  /** `command` renders behind a shell prompt; `fault` renders in the alert ink. */
  readonly tone?: 'plain' | 'command' | 'fault'
}

export interface BootAction {
  readonly label: string
  readonly onClick: () => void
}

/** True when the keystroke belongs to whatever the operator is typing into. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

/**
 * The link, drawn. Two nodes and a scan between them: the near one lit, the far
 * one faulted. It is the only moving thing on the screen and it carries the one
 * fact a still picture cannot — that Podium is still trying.
 */
function SignalTrace({ trace, pending }: { trace: BootTrace; pending: boolean }): JSX.Element {
  return (
    <div className="boot-trace" aria-hidden="true">
      <span className="boot-trace-node" />
      <span className="boot-trace-line" />
      <span className={pending ? 'boot-trace-node pending' : 'boot-trace-node fault'} />
      <span className="boot-trace-label">{trace.from}</span>
      <span />
      <span className="boot-trace-label boot-trace-label-end">{trace.to}</span>
    </div>
  )
}

export function BootScreen({
  eyebrow,
  headline,
  prose,
  fields = [],
  trace,
  reassurance,
  pending = false,
  detail,
  primary,
  secondary,
  panelLabel = 'Recovery console',
}: {
  /** Mono kicker: the fault's category, never a sentence. */
  eyebrow: string
  /** Up to two short lines; a newline in the string breaks them. */
  headline: string
  /** The sentence the operator is owed. May carry emphasis as a node. */
  prose: ReactNode
  fields?: readonly BootField[]
  trace?: BootTrace
  /** One line under the fields, in the trace's own ink. */
  reassurance?: string
  /** True when Podium is still retrying behind this screen — the far node
   *  breathes in the waiting colour rather than the alert one. */
  pending?: boolean
  /** Raw diagnostic text, tucked behind "What happened". */
  detail?: string
  primary: BootAction
  secondary?: BootAction
  panelLabel?: string
}): JSX.Element {
  const [copied, setCopied] = useState(false)
  const [first, second] = headline.split('\n')

  // The exit must be reachable without a mouse: focus lands on the primary
  // action (autoFocus, below), and `R` triggers it from anywhere on the screen.
  const act = primary.onClick
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'r' && event.key !== 'R') return
      if (event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) return
      event.preventDefault()
      act()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [act])

  async function copyReport(): Promise<void> {
    if (!detail) return
    try {
      await navigator.clipboard.writeText(detail)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      // A denied clipboard is not worth a second error screen; the text is on
      // screen already and can be selected by hand.
    }
  }

  return (
    <main className={pending ? 'boot-screen is-pending' : 'boot-screen'}>
      <style>{BOOT_SCREEN_CSS}</style>
      <div className="boot-screen-inner">
        <section className="boot-brand" aria-labelledby="boot-screen-title">
          <AsciiWordmark color="var(--text-strong, var(--foreground))" />
          <div className="boot-eyebrow">{eyebrow}</div>
          <h1 id="boot-screen-title" className="boot-headline">
            {first}
            {second !== undefined && (
              <>
                <br />
                {second}
              </>
            )}
          </h1>
          <p className="boot-prose">{prose}</p>
        </section>

        <section className="boot-panel" aria-label={panelLabel}>
          <header className="boot-panel-head">
            <span>{panelLabel}</span>
            <span className="boot-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
          </header>
          <div className="boot-panel-body">
            {trace && <SignalTrace trace={trace} pending={pending} />}
            {fields.length > 0 && (
              <dl className="boot-fields">
                {fields.map((field) => (
                  <div key={field.label}>
                    <dt>{field.label}</dt>
                    <dd className={field.tone === 'fault' ? 'is-fault' : undefined}>
                      {field.tone === 'command' && <span className="boot-prompt">$ </span>}
                      {field.value}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
            {reassurance && (
              <div className={pending ? 'boot-reassurance is-pending' : 'boot-reassurance'}>
                {/* A reassurance is only ever "we are still trying", so the mark turns
                    whenever there is one — a still icon beside that sentence reads as a
                    retry that already gave up. */}
                <RotateCw size={12} aria-hidden="true" className="boot-spin" />
                {reassurance}
              </div>
            )}
            <div className="boot-actions">
              <button autoFocus className="boot-button" data-pressable type="button" onClick={primary.onClick}>
                <span>{primary.label}</span>
                <ArrowRight size={16} strokeWidth={2} aria-hidden="true" />
              </button>
              {secondary && (
                <button
                  data-pressable
                  className="boot-button-ghost"
                  type="button"
                  onClick={secondary.onClick}
                >
                  {secondary.label}
                </button>
              )}
            </div>
            {detail && (
              <details className="boot-detail">
                {/* The label alone read as a heading, not a control. The chevron
                    sits after the words so the label, the fields and the button
                    all keep one left edge. */}
                <summary>
                  What happened
                  <ChevronRight size={11} aria-hidden="true" />
                </summary>
                <pre>{detail}</pre>
                <button
                  data-pressable
                  className="boot-button-ghost"
                  type="button"
                  onClick={() => void copyReport()}
                >
                  {copied ? 'Copied' : 'Copy report'}
                </button>
              </details>
            )}
          </div>
        </section>
      </div>
    </main>
  )
}

/**
 * Scoped to this screen and inlined with it, for the same reason the setup
 * console inlines its own: this thing has to paint when the app around it did
 * not come up, and a stylesheet that arrives with the shell is a dependency it
 * cannot take.
 */
const BOOT_SCREEN_CSS = `
@keyframes boot-scan{0%{transform:translateX(-120%);opacity:0}18%{opacity:1}72%{opacity:1}100%{transform:translateX(430%);opacity:0}}
@keyframes boot-fault{0%,100%{box-shadow:0 0 0 0 color-mix(in oklab,var(--destructive) 28%,transparent)}50%{box-shadow:0 0 0 7px transparent}}
@keyframes boot-spin{to{transform:rotate(360deg)}}
.boot-screen{position:fixed;inset:0;z-index:100;display:flex;min-height:100%;overflow:auto;box-sizing:border-box;padding:clamp(20px,5vw,72px);color:var(--foreground);font-family:var(--font-sans);background:
  radial-gradient(700px 440px at 18% 42%,color-mix(in oklab,var(--primary) 7%,transparent),transparent 70%),
  linear-gradient(color-mix(in oklab,var(--foreground) 3%,transparent) 1px,transparent 1px),
  linear-gradient(90deg,color-mix(in oklab,var(--foreground) 3%,transparent) 1px,transparent 1px),
  var(--background);background-size:auto,32px 32px,32px 32px,auto}
.boot-screen-inner{width:min(1120px,100%);margin:auto;display:grid;grid-template-columns:minmax(0,1.22fr) minmax(330px,.78fr);gap:clamp(28px,4vw,68px);align-items:center}
.boot-brand{min-width:0;overflow:hidden}
.boot-brand pre{font-size:clamp(4.1px,.58vw,6.5px)!important;min-height:clamp(92px,13vw,143px)!important}
.boot-eyebrow{margin-top:24px;font:500 10px/1 var(--font-mono);letter-spacing:.16em;text-transform:uppercase;color:var(--destructive)}
.boot-screen.is-pending .boot-eyebrow{color:var(--attention,var(--primary))}
.boot-headline{max-width:22ch;margin:13px 0 0;font-size:clamp(30px,3.9vw,47px);font-weight:580;line-height:1.02;letter-spacing:-.038em;text-wrap:balance;color:var(--text-strong,var(--foreground))}
.boot-prose{max-width:56ch;margin:22px 0 0;color:var(--muted-foreground);font-size:15px;line-height:1.65}
.boot-panel{border:1px solid var(--hairline-bar,var(--border));border-radius:16px;background:linear-gradient(145deg,color-mix(in oklab,var(--foreground) 3%,transparent),transparent 45%),var(--card);box-shadow:0 30px 90px var(--carve-drop,rgb(0 0 0/.42)),inset 0 1px 0 color-mix(in oklab,var(--foreground) 4%,transparent);overflow:hidden}
.boot-panel-head{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:12px 15px;border-bottom:1px solid color-mix(in oklab,var(--foreground) 12%,transparent);font:500 9px/1 var(--font-mono);letter-spacing:.13em;text-transform:uppercase;color:var(--text-faint,var(--muted-foreground))}
.boot-dots{display:flex;gap:6px}
.boot-dots i{display:block;width:6px;height:6px;border-radius:50%;background:var(--border-strong,var(--border))}
.boot-dots i:first-child{background:var(--destructive)}
.boot-panel-body{padding:30px}
.boot-trace{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:10px 12px;margin:0 0 26px}
.boot-trace-line{position:relative;height:1px;overflow:hidden;background:var(--border-strong,var(--border))}
.boot-trace-line:after{content:'';position:absolute;inset:-1px auto -1px 0;width:24%;background:linear-gradient(90deg,transparent,var(--primary),transparent);animation:boot-scan 2.6s ease-in-out infinite}
.boot-trace-node{width:8px;height:8px;border-radius:50%;background:var(--success,var(--primary));box-shadow:0 0 12px color-mix(in oklab,var(--success,var(--primary)) 45%,transparent)}
.boot-trace-node.fault{background:var(--destructive);box-shadow:none;animation:boot-fault 1.8s ease-in-out infinite}
.boot-trace-node.pending{background:var(--attention,var(--primary));box-shadow:0 0 12px color-mix(in oklab,var(--attention,var(--primary)) 45%,transparent)}
.boot-trace-label{font:500 9px/1 var(--font-mono);letter-spacing:.1em;text-transform:uppercase;color:var(--text-faint,var(--muted-foreground));white-space:nowrap}
.boot-trace-label-end{text-align:right}
.boot-fields{display:grid;gap:18px;margin:0}
.boot-fields dt{margin-bottom:7px;font:500 9px/1 var(--font-mono);letter-spacing:.12em;text-transform:uppercase;color:var(--text-faint,var(--muted-foreground))}
.boot-fields dd{margin:0;font:500 13px/1.4 var(--font-mono);font-variant-ligatures:none;color:var(--text-strong,var(--foreground));overflow-wrap:anywhere}
.boot-fields dd.is-fault{color:var(--destructive)}
.boot-prompt{color:var(--text-faint,var(--muted-foreground))}
.boot-reassurance{display:flex;align-items:flex-start;gap:9px;margin:27px 0 0;color:var(--destructive);font:500 11px/1.5 var(--font-mono)}
.boot-reassurance svg{flex:none;margin-top:2px}
.boot-reassurance.is-pending{color:var(--attention,var(--primary))}
.boot-spin{animation:boot-spin 1.6s linear infinite}
.boot-actions{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-top:22px}
.boot-button{display:flex;flex:1 1 auto;min-width:180px;height:48px;align-items:center;justify-content:space-between;border:0;border-radius:10px;padding:0 15px;background:var(--primary);color:var(--primary-foreground);font:650 12px/1 var(--font-mono);letter-spacing:.02em;cursor:pointer}
.boot-button:hover{background:color-mix(in oklab,var(--primary) 92%,var(--foreground))}
.boot-button:focus-visible,.boot-button-ghost:focus-visible,.boot-detail summary:focus-visible{outline:2px solid var(--ring,var(--primary));outline-offset:3px}
.boot-button-ghost{border:0;border-radius:8px;padding:8px 10px;margin-left:-10px;background:none;color:var(--muted-foreground);font:500 11px/1 var(--font-mono);cursor:pointer}
.boot-button-ghost:hover{color:var(--text-strong,var(--foreground))}
.boot-detail{margin-top:26px;border-top:1px solid color-mix(in oklab,var(--foreground) 12%,transparent);padding-top:14px}
.boot-detail summary{display:flex;width:fit-content;align-items:center;gap:6px;list-style:none;cursor:pointer;font:500 9px/1 var(--font-mono);letter-spacing:.12em;text-transform:uppercase;color:var(--text-faint,var(--muted-foreground))}
.boot-detail summary:hover{color:var(--muted-foreground)}
.boot-detail summary::-webkit-details-marker{display:none}
.boot-detail summary svg{transition:transform .15s ease}
.boot-detail[open] summary svg{transform:rotate(90deg)}
.boot-detail pre{margin:12px 0 0;max-height:180px;overflow:auto;font:400 10.5px/1.7 var(--font-mono);font-variant-ligatures:none;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--muted-foreground)}
@media(max-width:860px){.boot-screen-inner{grid-template-columns:1fr;gap:32px}.boot-brand pre{font-size:min(1vw,5.4px)!important;min-height:112px!important}.boot-panel{border-radius:13px}}
@media(max-width:480px){.boot-screen{padding:16px}.boot-brand pre{font-size:3.35px!important;min-height:76px!important}.boot-panel-body{padding:22px}.boot-headline{max-width:none;font-size:clamp(27px,7.4vw,34px)}.boot-prose{font-size:14.5px}}
@media(prefers-reduced-motion:reduce){.boot-screen *{animation:none!important;transition:none!important}}
`
