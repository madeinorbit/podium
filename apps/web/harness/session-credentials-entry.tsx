/**
 * The credential controls on sessions (epic Task 18), with planted data and no
 * server. `?scene=` picks one: `composer`, `header`, `busy`, `outcomes`,
 * `mismatch`, `attention`, `refused`, `refused-pane`, `refused-elsewhere`,
 * `before` (the bar a refused start used to get), `login-bar` (three sessions on
 * a machine whose Claude Code login is out: only the one on its own login gets
 * the "isn't logged in" bar, POD-7062). `?theme=light` for light.
 */
import { sessionValues } from '@podium/client-core/session-values'
import { sessionCredentialChoices } from '@podium/client-graph/session-credential-facts'
import { asCredentialId, asMachineId, asSessionId, type CredentialView } from '@podium/model'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { toast } from 'sonner'
import { DensityProvider } from '@/app/density'
import { ThemeProvider } from '@/app/theme'
import { Toaster } from '@/components/ui/sonner'
import {
  type CredentialPick,
  CredentialPicker,
} from '@/features/credentials/session/CredentialPicker'
import { RefusedLaunchBannerView } from '@/features/credentials/session/RefusedLaunchBanner'
import {
  type ChipSession,
  SessionCredentialChipView,
} from '@/features/credentials/session/SessionCredentialChip'
import { SessionCredentialNoticeView } from '@/features/credentials/session/SessionCredentialNotice'
import { switchOutcome } from '@/features/credentials/session/switch-outcome'
import { ExitedBanner } from '@/features/terminal/SessionLifecyclePanes'
import { SessionLoginBar } from '@/features/terminal/SessionLoginBar'
import '@/index.css'
import '@/styles.css'

const params = new URLSearchParams(location.search)
const scene = params.get('scene') ?? 'composer'
const light = params.get('theme') === 'light'
localStorage.setItem('podium.theme.mode', light ? 'light' : 'dark')
document.documentElement.setAttribute('data-theme', 'podium')
document.documentElement.classList.toggle('dark', !light)

const ME = 'user:me'
const LAPTOP = asMachineId('laptop')
const cred = (n: number, over: Partial<CredentialView>): CredentialView =>
  ({
    id: asCredentialId(`cred_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`),
    ownerUserId: ME,
    label: 'Credential',
    type: 'anthropic.api-key',
    identity: {},
    status: 'ok',
    homes: [],
    allowedMachines: [],
    sessionCount: 0,
    access: 'owner',
    ...over,
  }) as CredentialView
const home = (id: string) => [{ machineId: LAPTOP, homeId: id, state: 'in' as const }]
const workMax = cred(1, {
  label: 'Work Max',
  type: 'anthropic.claude-login',
  identity: { email: 'work@example.test', plan: 'Max' },
  homes: home('w:claude-code'),
})
const personalPro = cred(2, {
  label: 'Personal Pro',
  type: 'anthropic.claude-login',
  identity: { email: 'me@example.test', plan: 'Pro' },
  homes: home('p:claude-code'),
})
const teamKey = cred(3, { label: 'Team key', identity: { masked: 'sk-a…7f3c' } })
const ciToken = cred(4, {
  label: 'CI token',
  type: 'anthropic.claude-token',
  identity: { masked: 'sk-ant-oat…91' },
  status: 'attention',
  statusReason: 'It expired on Nov 10.',
})
const codexKey = cred(5, { label: 'OpenAI key', type: 'openai.api-key' })
const views = [workMax, personalPro, teamKey, ciToken, codexKey]
const accepts = [
  { type: 'anthropic.api-key' },
  { type: 'anthropic.claude-token' },
  { type: 'anthropic.claude-login' },
]
const custodianOf = () => ME
const session = (over: Partial<ChipSession> = {}): ChipSession => ({
  sessionId: asSessionId('00000000-0000-4000-8000-000000000001'),
  agentKind: 'claude-code',
  machineId: LAPTOP,
  status: 'live',
  credentialId: workMax.id,
  agentState: { phase: 'idle', since: '2026-11-17T10:00:00.000Z' },
  ...over,
})
const onSwitch = async () => undefined

function Header({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-[34px] items-center gap-2 border-b border-hairline-soft pr-2 pl-[18px] text-[11.5px] text-text-dim">
      <span>issue/1234-login-form</span>
      <span className="ml-auto inline-flex items-center gap-2">
        {children}
        <span className="text-[12px] text-text-faint">Opus 5.5 · High</span>
      </span>
    </div>
  )
}

function Transcript() {
  return (
    <div className="p-6 text-[13px] text-text-dim">
      <p className="m-0 rounded-lg bg-secondary/50 p-3">Fix the login form validation.</p>
    </div>
  )
}

/** One session pane's top: its header, the login bar when its condition says
 *  so, and its credential notice. The condition is the shared session model's,
 *  derived from the machine record exactly as the app derives it. */
function LoginBarPane({ caption, s }: { caption: string; s: ChipSession }) {
  const { condition } = sessionValues(s, {
    machine: { name: 'Laptop', loggedOutHarnesses: ['claude-code'] },
  })
  return (
    <section className="border-b border-hairline-soft">
      <p className="m-0 px-[18px] pt-3 pb-1 text-[11px] text-text-faint uppercase tracking-wide">
        {caption}
      </p>
      <Header>
        <SessionCredentialChipView
          session={s}
          views={views}
          accepts={accepts}
          custodianOf={custodianOf}
          onSwitch={onSwitch}
        />
      </Header>
      {condition === 'logged-out' && (
        <SessionLoginBar agentKind={s.agentKind} terminalOutlook="terminal" />
      )}
      <SessionCredentialNoticeView
        session={s}
        views={views}
        accepts={accepts}
        custodianOf={custodianOf}
        onSwitch={onSwitch}
        onRenew={() => {}}
      />
    </section>
  )
}

function Composer() {
  const [pick, setPick] = useState<CredentialPick | undefined>(undefined)
  const chip =
    'inline-flex h-7 items-center gap-1.5 rounded-[7px] px-2 text-[12px] text-text-faint hover:bg-secondary hover:text-text-strong'
  return (
    <div className="mx-auto mt-16 w-[640px] rounded-xl border border-hairline-soft bg-card p-3">
      <div className="min-h-16 p-2 text-[14px] text-text-faint">Describe the task…</div>
      <div className="flex items-center gap-1">
        <span className={chip}>Claude Code Opus 5.5 · High</span>
        <span className={chip}>Laptop</span>
        <CredentialPicker
          harness="claude-code"
          machineId={LAPTOP}
          views={views}
          accepts={accepts}
          defaultId={workMax.id}
          custodianOf={custodianOf}
          pick={pick}
          onPick={setPick}
          className={chip}
        />
      </div>
    </div>
  )
}

function Scene() {
  switch (scene) {
    case 'composer':
      return <Composer />
    case 'header':
    case 'busy':
      return (
        <>
          <Header>
            <SessionCredentialChipView
              session={session(
                scene === 'busy'
                  ? {
                      agentState: {
                        phase: 'working',
                        since: '2026-11-17T10:00:00.000Z',
                        turnStartedAt: '2026-11-17T10:00:00.000Z',
                      },
                    }
                  : {},
              )}
              views={views}
              accepts={accepts}
              custodianOf={custodianOf}
              onSwitch={onSwitch}
            />
          </Header>
          <Transcript />
        </>
      )
    case 'outcomes': {
      setTimeout(() => {
        for (const result of [
          { continuedAs: 'resume' as const },
          { continuedAs: 'resume' as const, waitingForTurnEnd: true as const },
          { continuedAs: 'next-wake' as const },
          { continuedAs: 'handoff' as const, handoffSessionId: asSessionId('s2') },
        ]) {
          const out = switchOutcome(result, 'Personal Pro')
          toast(out.text, out.openSessionId ? { action: { label: 'Open', onClick: () => {} } } : {})
        }
      }, 50)
      return (
        <Header>
          <SessionCredentialChipView
            session={session({ credentialId: personalPro.id })}
            views={views}
            accepts={accepts}
            custodianOf={custodianOf}
            onSwitch={onSwitch}
          />
        </Header>
      )
    }
    case 'mismatch':
    case 'attention': {
      const s =
        scene === 'mismatch'
          ? {
              ...session(),
              credentialMismatch: {
                chosen: {
                  credentialId: workMax.id,
                  method: 'subscription' as const,
                  email: 'work@example.test',
                },
                reported: { method: 'subscription' as const, email: 'me@example.test' },
              },
            }
          : session({ credentialId: ciToken.id })
      return (
        <>
          <Header>
            <SessionCredentialChipView
              session={s}
              views={views}
              accepts={accepts}
              custodianOf={custodianOf}
              onSwitch={onSwitch}
            />
          </Header>
          <SessionCredentialNoticeView
            session={s}
            views={views}
            accepts={accepts}
            custodianOf={custodianOf}
            onSwitch={onSwitch}
            onRenew={() => {}}
          />
          <Transcript />
        </>
      )
    }
    case 'refused':
    case 'refused-pane':
    case 'refused-elsewhere': {
      const choices = sessionCredentialChoices({
        views,
        accepts,
        machineId: LAPTOP,
        custodianOf,
      })
      const banner = (
        <RefusedLaunchBannerView
          refusal={scene === 'refused-elsewhere' ? 'not-on-this-machine' : 'needs-attention'}
          choices={choices}
          onRenew={() => {}}
          onPick={() => {}}
          onDismiss={() => {}}
        />
      )
      return scene === 'refused-pane' ? (
        <div className="flex h-[420px] flex-col">{banner}</div>
      ) : (
        <>
          {banner}
          <Transcript />
        </>
      )
    }
    case 'login-bar':
      return (
        <>
          <LoginBarPane
            caption="Its own login · Claude Code is signed out on Laptop"
            s={session({ credentialId: undefined })}
          />
          <LoginBarPane caption="An API key" s={session({ credentialId: teamKey.id })} />
          <LoginBarPane
            caption="A token that needs attention"
            s={session({ credentialId: ciToken.id })}
          />
        </>
      )
    case 'before':
      return (
        <>
          <ExitedBanner
            sessionId={asSessionId('00000000-0000-4000-8000-000000000001')}
            exitCode={undefined}
            spawnFailure="This credential needs attention before it can be used. Renew it or pick another."
            isShell={false}
            resumable={false}
          />
          <Transcript />
        </>
      )
    default:
      return <p>Unknown scene {scene}</p>
  }
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <ThemeProvider>
    <DensityProvider>
      <div className="min-h-screen bg-background text-foreground">
        <Scene />
      </div>
      <Toaster expand visibleToasts={4} />
    </DensityProvider>
  </ThemeProvider>,
)
