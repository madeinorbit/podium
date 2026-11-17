import type { CredentialView } from '@podium/model'
import { observer } from 'mobx-react-lite'
import type { JSX } from 'react'
import { useCallback } from 'react'
import { useSettingsRecords } from '@/features/settings/record-readers'
import { FoundLoginSwitch } from '@/features/credentials/found-login-controls'
import { identityText } from '@/features/credentials/credential-facts'

import { useSettingsTrpc } from '@/features/settings/stable-access'

/**
 * ONBOARDING'S D11 STEP (POD-6301; September addendum §5): every account Podium
 * detected on the person's machines, each with its own unticked box. The same
 * box is in Settings → Credentials for logins found later. Nothing renders while
 * no account with a known identity was detected.
 */
const credentialKey = (view: CredentialView) => view.id as string

export const OnboardingAccountChoices = observer(
  function OnboardingAccountChoices(): JSX.Element | null {
    const trpc = useSettingsTrpc()
    const readAccounts = useCallback(() => trpc.credentials.list.query(), [trpc])
    const { request, reload } = useSettingsRecords('credential', readAccounts, credentialKey)
    const detected = ((request?.models ?? []) as unknown as CredentialView[]).filter((view) => view.access === 'owner' && view.nativeLogin?.useOnMyMachines !== undefined)
    if (detected.length === 0) return null
    return (
      <section
        aria-label="Detected accounts"
        className="mt-3 overflow-hidden rounded-[13px] bg-[#1b1e24] shadow-[inset_0_0_0_1px_#2f343d]"
      >
        <div className="border-b border-[#272b33] bg-[#1f2329] px-5 py-2.5 text-[12px] leading-none font-semibold text-[#a8adb6]">
          Accounts on your machines
        </div>
        {detected.map((account, index) => (
          <div
            key={account.id}
            className={
              index < detected.length - 1 ? 'border-b border-[#272b33] px-5 pt-3' : 'px-5 pt-3'
            }
          >
            <p className="pb-2 text-[13.5px] leading-none font-semibold text-[#e6e8ec]">
              {account.label}
              {identityText(account) ? (
                <span className="ml-2 font-normal text-[#9ba1ab]">{identityText(account)}</span>
              ) : null}
            </p>
            <FoundLoginSwitch view={account} commands={trpc.credentials} reload={() => void reload()} />
          </div>
        ))}
      </section>
    )
  },
)
