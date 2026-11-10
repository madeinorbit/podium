/** Isolated fixtures: the shared controls and existing settings leaf editors. */
import './settings-frame-store'
import { applySettingsPatch } from '@podium/commands/settings-write-plan'
import { normalizeSettings, type PodiumSettings } from '@podium/runtime'
import { observable, runInAction } from 'mobx'
import { observer } from 'mobx-react-lite'
import { useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { toast } from 'sonner'
import { DensityProvider } from '@/app/density'
import { ThemeProvider } from '@/app/theme'
import { Button } from '@/components/ui/button'
import { Toaster } from '@/components/ui/sonner'
import { settingsChange } from '@/features/settings/save-settings'
import { LabsSection } from '@/features/settings/sections/labs'
import { HibernationSection } from '@/features/settings/sections/hibernation'
import { NotificationsSection } from '@/features/settings/sections/notifications'
import { PrivacySection } from '@/features/settings/sections/privacy'
import { SessionsSection } from '@/features/settings/sections/sessions'
import {
  ConfirmInline,
  NumberRow,
  Row,
  SecretRow,
  Section,
  SegmentedRow,
  SelectRow,
  SettingsControlsContext,
  SwitchRow,
  TextRow,
  ValueRow,
} from '@/features/settings/sections/shared'
import { WorkflowSection } from '@/features/settings/sections/workflow'
import { SettingsFrame } from '@/features/settings/settings-frame'
import { trpc } from './settings-frame-store'
import '@/index.css'
import '@/styles.css'

const params = new URLSearchParams(location.search)
const member = params.get('as') === 'member'
const scene = params.get('scene') ?? 'controls'
const light = params.get('theme') === 'light'
localStorage.setItem('podium.theme.mode', light ? 'light' : 'dark')
document.documentElement.setAttribute('data-theme', 'podium')
document.documentElement.classList.toggle('dark', !light)
const permitted = {
  'records.userPreferences.edit': true,
  'records.instancePreferences.edit': !member,
  'settings.setSecret': !member,
  'settings.clearSecret': !member,
}
const Harness = observer(function Harness() {
  const settings = useMemo(() => observable(normalizeSettings({})), [])
  const [feedback, setFeedback] = useState<Record<string, { error?: string }>>({})
  const [secret, setSecret] = useState('demo-key-1234')
  const [topic, setTopic] = useState('podium-updates')
  const [mode, setMode] = useState('auto')
  const [model, setModel] = useState('auto')
  const [number, setNumber] = useState<number | null | undefined>(80)
  const [enabled, setEnabled] = useState(true)
  const [confirming, setConfirming] = useState(params.has('confirm'))
  const patch = async (patch: Partial<PodiumSettings>) => {
    const change = settingsChange(settings, patch)
    const writer = async (values: Readonly<Record<string, unknown>>) => {
      if (params.has('refused')) throw new Error('This setting is locked by the deployment.')
      runInAction(() => Object.assign(settings, applySettingsPatch(settings, values)))
    }
    try {
      const undo = await change.save(
        trpc,
        () => settings,
        { personal: writer, instance: writer },
        permitted,
      )
      toast('Saved', {
        action: {
          label: 'Undo',
          onClick: () => {
            void undo()
          },
        },
      })
    } catch (error) {
      setFeedback(
        Object.fromEntries(change.paths.map((path) => [path, { error: (error as Error).message }])),
      )
    }
  }
  return (
    <ThemeProvider>
      <DensityProvider>
        <SettingsFrame
          page={scene === 'controls' ? 'projects' : (scene as 'machines')}
          selectedPage
          onClose={() => {}}
          onPageChange={() => {}}
          viewer={{
            status: 'ready',
            sections: member ? [] : ['people', 'access', 'machines', 'instance', 'audit'],
            retry() {},
          }}
        >
          <SettingsControlsContext.Provider value={{ settings, permitted, feedback }}>
            {member && (
              <p className="settings-prose mb-4">
                Only admins can change these. You can see what is set.
              </p>
            )}
            {scene === 'machines' ? (
              <HibernationSection settings={settings} patch={patch} />
            ) : scene === 'projects' ? (
              <WorkflowSection settings={settings} patch={patch} />
            ) : scene === 'notifications' ? (
              <NotificationsSection
                settings={settings}
                patch={patch}
                telegramSetup={{ status: 'idle' }}
                onStartTelegramSetup={() => {}}
                onResetTelegramSetup={() => {}}
              />
            ) : scene === 'privacy' ? (
              <PrivacySection settings={settings} patch={patch} />
            ) : scene === 'labs' ? (
              <LabsSection settings={settings} patch={patch} />
            ) : scene === 'agents' ? (
              <SessionsSection settings={settings} patch={patch} accounts={[]} />
            ) : (
              <Section
                title="Shared settings controls"
                hint="Changes save immediately. Text and numbers save on Enter or when you leave the field."
              >
                <SwitchRow
                  label="Pause idle sessions"
                  description="Keeps the workspace responsive when machines are busy."
                  setting="hibernation.enabled"
                  value={settings.hibernation.enabled}
                  onChange={(enabled) =>
                    patch({ hibernation: { ...settings.hibernation, enabled } })
                  }
                />
                <SegmentedRow
                  label="Open new sessions in"
                  description="Auto shows chat on a phone and the terminal on a computer."
                  value={mode}
                  onChange={setMode}
                  options={[
                    { value: 'terminal', label: 'Terminal' },
                    { value: 'chat', label: 'Chat' },
                    { value: 'auto', label: 'Auto' },
                  ]}
                />
                <SelectRow
                  label="Model"
                  description="Auto follows the agent’s default."
                  value={model}
                  onChange={setModel}
                  groups={[
                    {
                      label: 'Default',
                      options: [{ value: 'auto', label: 'Auto', hint: 'Agent default' }],
                    },
                    {
                      label: 'Available models',
                      options: [
                        { value: 'fast', label: 'Fast', hint: 'For short tasks' },
                        { value: 'deep', label: 'Thorough', hint: 'For longer tasks' },
                      ],
                    },
                  ]}
                />
                <TextRow
                  label="ntfy topic"
                  description="Leave empty to turn ntfy notifications off."
                  value={topic}
                  onChange={setTopic}
                  placeholder="Your topic"
                />
                <NumberRow
                  label="Memory threshold"
                  description="Pause sooner when memory is above this level."
                  value={number}
                  onChange={setNumber}
                  min={50}
                  max={95}
                  unit="%"
                  placeholder="Off"
                />
                <SwitchRow
                  label="Notification sounds"
                  description="Play a short sound when an agent needs you."
                  value={enabled}
                  onChange={setEnabled}
                  device
                />
                <SecretRow
                  label="API key"
                  description="Used by the background model."
                  present={Boolean(secret)}
                  last4={secret.slice(-4)}
                  onSave={async (value) => setSecret(value)}
                  onRemove={async () => {
                    const previous = secret
                    setSecret('')
                    return async () => setSecret(previous)
                  }}
                />
                <ValueRow
                  label="Role"
                  description="Your access in this workspace."
                  value={member ? 'Member' : 'Admin'}
                />
                <Row
                  label="Shared machine"
                  description="Choose when a key can run on someone else’s machine."
                >
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setConfirming(true)}
                  >
                    Send key
                  </Button>
                </Row>
                {confirming && (
                  <ConfirmInline
                    sentence="Anyone who can run agents on this machine may use this key."
                    actionLabel="Send key"
                    hasPassword={!params.has('passwordless')}
                    acknowledgement="I understand who can use this key."
                    onConfirm={async () => {
                      setConfirming(false)
                      toast('Key sent')
                    }}
                    onCancel={() => setConfirming(false)}
                  />
                )}
              </Section>
            )}
          </SettingsControlsContext.Provider>
        </SettingsFrame>
        <Toaster position="bottom-center" />
      </DensityProvider>
    </ThemeProvider>
  )
})
createRoot(document.getElementById('root')!).render(<Harness />)
