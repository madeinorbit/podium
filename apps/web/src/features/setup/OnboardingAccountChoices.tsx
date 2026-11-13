import type { HarnessAgent } from '@podium/model'
import { observer } from 'mobx-react-lite'
import type { JSX } from 'react'
import { useCallback } from 'react'
import { accountKey, useSettingsRecords } from '@/features/settings/record-readers'
import { harnessAgentLabel } from '@/features/settings/sections/shared'
import {
  hasUseOnMyMachinesBox,
  UseOnMyMachinesBox,
} from '@/features/settings/sections/use-on-my-machines'
import { useSettingsTrpc } from '@/features/settings/stable-access'

/**
 * ONBOARDING'S D11 STEP (POD-6301; September addendum §5): every account Podium
 * detected on the person's machines, each with its own unticked box. The same
 * box is in Settings → AI accounts for accounts found later. Nothing renders while
 * no account with a known identity was detected.
 */
export const OnboardingAccountChoices = observer(
  function OnboardingAccountChoices(): JSX.Element | null {
    const trpc = useSettingsTrpc()
    const readAccounts = useCallback(() => trpc.accounts.list.query(), [trpc])
    const { request, reload } = useSettingsRecords('account', readAccounts, accountKey)
    const detected = (request?.models ?? []).filter(hasUseOnMyMachinesBox)
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
              {harnessAgentLabel(account.harness as HarnessAgent)}
              {account.identity ? (
                <span className="ml-2 font-normal text-[#9ba1ab]">{account.identity}</span>
              ) : null}
            </p>
            <UseOnMyMachinesBox account={account} trpc={trpc} onChanged={() => void reload()} />
          </div>
        ))}
      </section>
    )
  },
)
