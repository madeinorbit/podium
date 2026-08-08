import { ArrowRight, RotateCw } from 'lucide-react'
import type { JSX } from 'react'
import { AsciiWordmark } from './LoginGate'

const C = {
  bg: '#0a0a0e',
  panel: '#0e0e13',
  border: '#303039',
  accent: '#d97757',
  accentInk: '#2b1208',
  text: '#f3f3f8',
  dim: '#9a9aa8',
  faint: '#666671',
  danger: '#f43f5e',
  ok: '#10b981',
} as const

const MONO = "'Geist Mono Variable', ui-monospace, Menlo, monospace"

function endpointLabel(httpOrigin: string): string {
  try {
    return new URL(httpOrigin).host
  } catch {
    return httpOrigin || 'configured backend'
  }
}

/** A recovery console for the one startup failure developers can usually fix themselves. */
export function SetupUnreachable({
  httpOrigin,
  onRetry,
}: {
  httpOrigin: string
  onRetry: () => void
}): JSX.Element {
  const endpoint = endpointLabel(httpOrigin)

  return (
    <main className="podium-unreachable">
      <style>{`
        @keyframes podium-signal-scan{0%{transform:translateX(-120%);opacity:0}18%{opacity:1}72%{opacity:1}100%{transform:translateX(430%);opacity:0}}
        @keyframes podium-fault-pulse{0%,100%{box-shadow:0 0 0 0 rgba(244,63,94,.28)}50%{box-shadow:0 0 0 7px rgba(244,63,94,0)}}
        .podium-unreachable{position:fixed;inset:0;z-index:100;display:flex;min-height:100%;overflow:auto;box-sizing:border-box;padding:clamp(20px,5vw,72px);color:${C.text};font-family:'Geist Variable',sans-serif;background:radial-gradient(700px 440px at 18% 42%,rgba(217,119,87,.10),transparent 70%),linear-gradient(rgba(255,255,255,.018) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.018) 1px,transparent 1px),${C.bg};background-size:auto,32px 32px,32px 32px,auto}
        .podium-unreachable-inner{width:min(1080px,100%);margin:auto;display:grid;grid-template-columns:minmax(0,1.08fr) minmax(340px,.92fr);gap:clamp(40px,8vw,112px);align-items:center}
        .podium-unreachable-brand{min-width:0;overflow:hidden}
        .podium-unreachable-brand pre{font-size:clamp(4.1px,.58vw,6.5px)!important;min-height:clamp(92px,13vw,143px)!important}
        .podium-unreachable-panel{border:1px solid ${C.border};border-radius:16px;background:linear-gradient(145deg,rgba(255,255,255,.025),transparent 45%),${C.panel};box-shadow:0 30px 90px rgba(0,0,0,.42),inset 0 1px 0 rgba(255,255,255,.035);overflow:hidden}
        .podium-unreachable-head{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:12px 15px;border-bottom:1px solid ${C.border};font:500 9px/1 ${MONO};letter-spacing:.13em;text-transform:uppercase;color:${C.faint}}
        .podium-unreachable-dots{display:flex;gap:6px}.podium-unreachable-dots i{display:block;width:6px;height:6px;border-radius:50%;background:#35353d}.podium-unreachable-dots i:first-child{background:${C.danger}}
        .podium-signal{position:relative;display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:12px;margin:30px 0 28px;font:600 9px/1 ${MONO};letter-spacing:.12em;color:${C.faint}}
        .podium-signal-line{position:relative;height:1px;overflow:hidden;background:${C.border}}.podium-signal-line:after{content:'';position:absolute;inset:-1px auto -1px 0;width:24%;background:linear-gradient(90deg,transparent,${C.accent},transparent);animation:podium-signal-scan 2.6s ease-in-out infinite}
        .podium-signal-node{width:8px;height:8px;border-radius:50%;background:${C.ok};box-shadow:0 0 12px rgba(16,185,129,.45)}.podium-signal-node.fault{background:${C.danger};box-shadow:none;animation:podium-fault-pulse 1.8s ease-in-out infinite}
        .podium-unreachable-button{display:flex;width:100%;height:48px;align-items:center;justify-content:space-between;border:0;border-radius:10px;padding:0 15px;background:${C.accent};color:${C.accentInk};font:650 12px/1 ${MONO};cursor:pointer}.podium-unreachable-button:focus-visible{outline:2px solid ${C.text};outline-offset:3px}
        @media(max-width:760px){.podium-unreachable{padding:24px}.podium-unreachable-inner{grid-template-columns:1fr;gap:28px}.podium-unreachable-brand pre{font-size:min(1vw,5.4px)!important;min-height:112px!important}.podium-unreachable-panel{border-radius:13px}}
        @media(max-width:480px){.podium-unreachable{padding:16px}.podium-unreachable-brand pre{font-size:3.35px!important;min-height:76px!important}.podium-unreachable-panel-body{padding:24px!important}}
        @media(prefers-reduced-motion:reduce){.podium-unreachable *{animation:none!important;transition:none!important}}
      `}</style>

      <div className="podium-unreachable-inner">
        <section className="podium-unreachable-brand" aria-labelledby="unreachable-title">
          <AsciiWordmark color={C.text} />
          <div
            style={{
              marginTop: 24,
              fontFamily: MONO,
              fontSize: 10,
              letterSpacing: '.16em',
              textTransform: 'uppercase',
              color: C.accent,
            }}
          >
            Connection / interrupted
          </div>
          <h1
            id="unreachable-title"
            style={{
              maxWidth: 620,
              margin: '13px 0 0',
              fontSize: 'clamp(38px,5.4vw,70px)',
              fontWeight: 580,
              lineHeight: 0.98,
              letterSpacing: '-.045em',
            }}
          >
            The backend
            <br />
            went quiet.
          </h1>
          <p
            style={{
              maxWidth: 520,
              margin: '22px 0 0',
              color: C.dim,
              fontSize: 15,
              lineHeight: 1.65,
            }}
          >
            Your interface is ready, but the Podium server never answered. Your work is still on the
            host—restore the process, then reconnect.
          </p>
        </section>

        <section className="podium-unreachable-panel" aria-label="Backend connection status">
          <header className="podium-unreachable-head">
            <span>Recovery console</span>
            <span className="podium-unreachable-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
          </header>
          <div className="podium-unreachable-panel-body" style={{ padding: 30 }}>
            <div style={{ font: `500 10px/1 ${MONO}`, color: C.faint, letterSpacing: '.08em' }}>
              CONNECTION TRACE
            </div>
            <div className="podium-signal" aria-hidden="true">
              <span className="podium-signal-node" />
              <span className="podium-signal-line" />
              <span className="podium-signal-node fault" />
            </div>
            <div style={{ display: 'grid', gap: 18 }}>
              <div>
                <div
                  style={{
                    marginBottom: 7,
                    font: `500 9px/1 ${MONO}`,
                    color: C.faint,
                    letterSpacing: '.12em',
                  }}
                >
                  TARGET
                </div>
                <code style={{ color: C.text, font: `500 13px/1.4 ${MONO}` }}>{endpoint}</code>
              </div>
              <div>
                <div
                  style={{
                    marginBottom: 7,
                    font: `500 9px/1 ${MONO}`,
                    color: C.faint,
                    letterSpacing: '.12em',
                  }}
                >
                  NEXT CHECK
                </div>
                <code style={{ color: C.accent, font: `500 13px/1.4 ${MONO}` }}>
                  <span style={{ color: C.faint }}>$ </span>podium status
                </code>
              </div>
            </div>
            <div
              role="alert"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 9,
                margin: '27px 0 18px',
                color: '#f87171',
                font: `500 11px/1.4 ${MONO}`,
              }}
            >
              <RotateCw size={12} aria-hidden="true" />
              automatic retries exhausted
            </div>
            <button
              data-pressable
              className="podium-unreachable-button"
              type="button"
              onClick={onRetry}
            >
              <span>Retry connection</span>
              <ArrowRight size={16} strokeWidth={2} aria-hidden="true" />
            </button>
          </div>
        </section>
      </div>
    </main>
  )
}
