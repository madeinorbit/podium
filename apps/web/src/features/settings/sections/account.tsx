import { useCallback, useMemo, useState } from 'react'
import { serverConfig, type Trpc } from '@/app/trpc'
import { SettingsPageSection } from '../settings-anchors'
import { useSettingsFrame } from '../settings-frame'
import {
  createMobilePairingApi,
  PhonePairingFlow,
  SignedInDevicesSection,
} from './connected-devices'
import { AccountProfileSection } from './security'

export function AccountSection({ trpc, onOpenAccess }: { trpc: Trpc; onOpenAccess: () => void }) {
  const frame = useSettingsFrame()
  const origin = serverConfig(window.location).httpOrigin
  const api = useMemo(() => createMobilePairingApi(origin), [origin])
  const [refreshKey, setRefreshKey] = useState(0)
  const refreshDevices = useCallback(() => setRefreshKey((value) => value + 1), [])
  return (
    <>
      <SettingsPageSection id="security">
        <AccountProfileSection trpc={trpc} />
      </SettingsPageSection>
      <SettingsPageSection id="devices">
        <SignedInDevicesSection
          api={api}
          refreshKey={refreshKey}
          onPair={() =>
            frame.openTakeover({
              title: 'Pair a phone',
              description: 'Open the Podium app on your phone and scan this code.',
              content: (
                <PhonePairingFlow
                  api={api}
                  autoStart
                  onSessionsChanged={refreshDevices}
                  onOpenAccess={() => {
                    frame.closeTakeover()
                    onOpenAccess()
                  }}
                />
              ),
            })
          }
        />
      </SettingsPageSection>
    </>
  )
}
