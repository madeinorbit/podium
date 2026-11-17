/**
 * The credentials page's "Add subscription" screen (epic Task 9), with a fake
 * server. `?scene=` picks what the sign-in comes to: `waiting` (stays
 * waiting), `new`, `attached`, `identity-changed` or `failed`; `?type=chatgpt`
 * starts on the ChatGPT subscription.
 */
import { createRoot } from 'react-dom/client'
import { DensityProvider } from '@/app/density'
import { ThemeProvider } from '@/app/theme'
import { Toaster } from '@/components/ui/sonner'
import {
  AddSubscription,
  type SubscriptionSignInCommands,
  type SubscriptionSignInStatus,
} from '@/features/credentials/add-subscription/add-subscription'
import '@/index.css'
import '@/styles.css'

const params = new URLSearchParams(location.search)
const scene = params.get('scene') ?? 'waiting'
const light = params.get('theme') === 'light'
localStorage.setItem('podium.theme.mode', light ? 'light' : 'dark')
document.documentElement.setAttribute('data-theme', 'podium')
document.documentElement.classList.toggle('dark', !light)

const outcome: Record<string, SubscriptionSignInStatus> = {
  new: {
    state: 'signed-in',
    credentialId: 'cred_new',
    label: 'second@example.test',
    email: 'second@example.test',
    outcome: 'new',
  },
  attached: {
    state: 'signed-in',
    credentialId: 'cred_b',
    label: 'Work Max',
    email: 'work@example.test',
    outcome: 'attached',
  },
  'identity-changed': {
    state: 'signed-in',
    credentialId: 'cred_a',
    label: 'Personal Max',
    email: 'work@example.test',
    previousEmail: 'personal@example.test',
    outcome: 'identity-changed',
  },
  failed: { state: 'failed', reason: 'The sign-in ended without signing in (exit 1).' },
}

const commands: SubscriptionSignInCommands = {
  signInStart: {
    mutate: async () => ({ credentialId: 'cred_new', terminalSessionId: 'session:signin' }),
  },
  signInCancel: { mutate: async () => ({ ok: true }) },
  signInStatus: {
    query: async () =>
      outcome[scene] ?? {
        state: 'waiting',
        machineId: 'machine:desk',
        terminalSessionId: 'session:signin',
      },
  },
}

createRoot(document.getElementById('root')!).render(
  <ThemeProvider>
    <DensityProvider>
      <div className="min-h-screen bg-background p-8 text-foreground">
        <div className="max-w-[560px] rounded-lg border p-6">
          <h2 className="settings-title mb-4">Add subscription</h2>
          <AddSubscription
            commands={commands}
            deps={{ reload: () => {} }}
            machines={[
              { id: 'machine:desk', name: 'Desk' },
              { id: 'machine:build', name: 'Build box' },
            ]}
            openTerminal={() => {}}
            {...(params.get('type') === 'chatgpt' ? { type: 'openai.chatgpt-login' as const } : {})}
            pollMs={200}
            onDone={() => {}}
          />
        </div>
      </div>
      <Toaster />
    </DensityProvider>
  </ThemeProvider>,
)
