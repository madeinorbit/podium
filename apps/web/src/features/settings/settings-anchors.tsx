import { createContext, useContext, type ReactNode } from 'react'
import { settingsRowId, settingsSectionId } from './page-definitions'

const SettingsSectionContext = createContext<string | null>(null)

/** Give unchanged legacy sections a search address without coupling their
 * forms or persistence to the frame. */
export function SettingsPageSection({ id, children }: { id: string; children: ReactNode }) {
  return (
    <SettingsSectionContext.Provider value={id}>
      <div id={settingsSectionId(id)} className="settings-page-section" tabIndex={-1}>
        {children}
      </div>
    </SettingsSectionContext.Provider>
  )
}

export function useSettingsRowId(label: string): string | undefined {
  const section = useContext(SettingsSectionContext)
  return section ? settingsRowId(section, label) : undefined
}
