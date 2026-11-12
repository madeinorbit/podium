import type { JSX } from 'react'

/**
 * Adding a folder to Podium is the act of trusting it, for every harness
 * (harness-session-posture.md, decision 1). This is where that is said: one
 * sentence under each field that names the folder being added.
 */
export const FOLDER_TRUST_NOTICE =
  "Agents can read, change and run files in this folder, and the folder's own agent settings and hooks apply. Podium tells each agent the folder is trusted, so none of them asks again."

/** Give the folder field `aria-describedby={id}` so a screen reader reads it with the field. */
export function FolderTrustNotice({ id }: { id: string }): JSX.Element {
  return (
    <p id={id} className="mt-3 text-[12px] leading-[1.5] text-muted-foreground">
      {FOLDER_TRUST_NOTICE}
    </p>
  )
}
