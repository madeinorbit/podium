import { useCommands, useRequestClient, useUi } from '@podium/client-core/react'
import type { SessionModel } from '@podium/client-graph'
import type { MachineHarness } from '@podium/client-graph/machine-harness'
import type { CredentialId, IssueId, SessionId } from '@podium/model'
import { observer } from 'mobx-react-lite'
import { useState } from 'react'
import { useWorklistPool } from '@/app/store-worklist-pool'
import type { Trpc } from '@/app/trpc'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { CredentialMenuItems } from '@/features/credentials/session/CredentialMenuItems'
import { useOpenCredentials } from '@/features/credentials/session/SessionCredentialNotice'
import { sessionCredentialChoices } from '@/features/credentials/session/session-credential-facts'
import {
  useHarnessAccepts,
  useSessionCredentials,
} from '@/features/credentials/session/use-session-credentials'

/** Installation is explicit, followed by a credential for Podium's separate side. */
export const InstallCurrentHarness = observer(function InstallCurrentHarness({
  sessionId,
  firstPrompt,
}: {
  sessionId: SessionId
  firstPrompt?: string
}) {
  const pool = useWorklistPool()
  const session = pool?.sessionObject(sessionId)
  const row = session?.installRecoveryHarness
  return row && session ? (
    <InstallCurrentHarnessControl session={session} row={row} firstPrompt={firstPrompt} />
  ) : null
})

const InstallCurrentHarnessControl = observer(function InstallCurrentHarnessControl({
  session,
  row,
  firstPrompt,
}: {
  session: SessionModel
  row: MachineHarness
  firstPrompt?: string
}) {
  const sessionId = session.sessionId
  const client = useRequestClient<Trpc>()
  const commands = useCommands<Trpc>()
  const ui = useUi()
  const openCredentials = useOpenCredentials()
  const credentials = useSessionCredentials()
  const accepts = useHarnessAccepts(row?.machine.id)
  const [installed, setInstalled] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const choices = credentials.views
    ? sessionCredentialChoices({
        views: credentials.views,
        accepts: accepts(row.kind),
        machineId: row.machine.id,
        custodianOf: credentials.custodianOf,
      })
    : []
  const start = (credentialId: CredentialId | null) => {
    if (!credentialId || !session.cwd) return
    const input = session.launch?.input as
      | { issueId?: IssueId; model?: string; effort?: string }
      | undefined
    const started = commands.sessions.launch({
      target: { path: session.cwd, repoPath: session.cwd, machineId: row.machine.id },
      agentKind: row.kind,
      ...(input?.issueId ? { issueId: input.issueId } : {}),
      credentialId,
      ...(firstPrompt ? { firstPrompt } : {}),
      ...(input?.model ? { model: input.model } : {}),
      ...(input?.effort ? { effort: input.effort } : {}),
    })
    void commands.sessions.killSession(sessionId)
    ui.navigateToSession(started.sessionId)
  }
  return (
    <div className="flex flex-wrap items-center gap-2" aria-live="polite">
      {!installed ? (
        <Button
          size="xs"
          variant="outline"
          disabled={busy || !row.canAct || row.inventory?.management?.installable === false}
          title={row.installReason}
          onClick={() => {
            setBusy(true)
            setError(null)
            void client.harnessInstalls.action
              .mutate({ machineId: row.machine.id, harness: row.kind, action: 'install' })
              .then(
                (result) => {
                  if (!result.ok) setError(result.error ?? 'The install failed.')
                  else {
                    setInstalled(true)
                    credentials.reload()
                  }
                },
                (cause: unknown) =>
                  setError(cause instanceof Error ? cause.message : String(cause)),
              )
              .finally(() => setBusy(false))
          }}
        >
          {busy ? 'Installing…' : 'Install a current version for Podium'}
        </Button>
      ) : (
        <>
          <span className="text-xs text-muted-foreground">
            Installed for Podium. Choose a credential; your own login stays in your folder.
          </span>
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger
              render={
                <Button size="xs" variant="outline">
                  Choose credential and start
                </Button>
              }
            />
            <DropdownMenuContent>
              <CredentialMenuItems
                choices={choices}
                ownLogin={false}
                selected={undefined}
                onSelect={start}
              />
            </DropdownMenuContent>
          </DropdownMenu>
          <Button size="xs" variant="ghost" onClick={openCredentials}>
            Add a credential
          </Button>
        </>
      )}
      {error && (
        <span role="alert" className="text-xs text-warning">
          {error}
        </span>
      )}
    </div>
  )
})
