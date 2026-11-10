import { observer } from '@podium/client-graph/react'
import { Check, Copy } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { useMachinePairing } from '@/features/machines/machine-pairing'
import { WorkingMark } from '@/lib/motion/WorkingMark'
import { MachineDetail } from './machine-detail'
import { useSettingsMachines } from './readers'
import { useSettingsFrame } from './settings-frame'
import { useSettingsClient } from './stable-access'

export const AddMachineFlow = observer(function AddMachineFlow() {
  const machines = useSettingsMachines()
  const { trpc, setSettingsTab } = useSettingsClient()
  const { closeTakeover, openTakeover } = useSettingsFrame()
  const pairing = useMachinePairing({ trpc, machines })
  const [managed, setManaged] = useState(true)
  const [step, setStep] = useState<'choose' | 'command'>('choose')
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState<string | null>(null)

  const mint = () => {
    pairing.watchForNewMachine()
    setStep('command')
    setCopied(false)
    setCopyError(null)
    void pairing.mint({ podiumManaged: managed })
  }
  const chooseAgain = () => {
    pairing.reset()
    setStep('choose')
    setCopied(false)
    setCopyError(null)
  }
  const access = () => {
    closeTakeover()
    setSettingsTab('access')
  }

  return (
    <ol className="space-y-7" aria-label="Add a machine steps">
      <li className="flex min-w-0 gap-4">
        <StepNumber number={1} complete={step === 'command'} />
        <div className="min-w-0 flex-1">
          <h4 className="settings-h2">Choose what it gets</h4>
          <label className="mt-4 flex items-start gap-3">
            <Switch aria-label="Copy agent logins from your other machines" checked={managed}
              disabled={step !== 'choose'} onCheckedChange={setManaged} />
            <span>
              <span className="settings-label">Copy agent logins from your other machines</span>
              <span className="settings-prose mt-1 block">Turn off for a shared computer that should keep its own.</span>
            </span>
          </label>
          {step === 'choose' ? (
            <Button type="button" size="sm" className="mt-4" onClick={mint}>Create command</Button>
          ) : (
            <Button type="button" variant="ghost" size="sm" className="mt-2" onClick={chooseAgain}>
              Change choice
            </Button>
          )}
        </div>
      </li>
      {step === 'command' && <>
        <li className="flex min-w-0 gap-4">
          <StepNumber number={2} complete={pairing.newMachine !== null} />
          <div className="min-w-0 flex-1">
            <h4 className="settings-h2">Run this on the other machine</h4>
            <p className="settings-prose mt-1">Paste it into a terminal there. The code works once and expires in 10 minutes.</p>
            {pairing.loading && <p className="settings-prose mt-4 flex items-center gap-2" role="status">
              <WorkingMark size={13} />Creating the command…
            </p>}
            {pairing.error && <p className="settings-prose mt-3 text-destructive" role="alert">{pairing.error}</p>}
            {!pairing.loading && !pairing.newMachine && pairing.joinCommand && (
              <div className="mt-4 flex min-w-0 flex-col gap-3">
                <code className="settings-value block max-w-full overflow-x-auto whitespace-nowrap rounded-md border border-border bg-muted px-3 py-3"
                  title={pairing.joinCommand}>{pairing.joinCommand}</code>
                <div className="flex flex-wrap items-center gap-3">
                  <Button type="button" variant="outline" size="sm" onClick={() => {
                    if (!pairing.joinCommand) return
                    setCopyError(null)
                    void navigator.clipboard.writeText(pairing.joinCommand)
                      .then(() => setCopied(true))
                      .catch(() => setCopyError('Could not copy. Select the command and copy it from the field.'))
                  }}><Copy size={14} aria-hidden="true" />{copied ? 'Copied' : 'Copy'}</Button>
                  <Button type="button" variant="ghost" size="sm" onClick={mint}>New code</Button>
                  <span className="settings-micro">Pairing code <code>{pairing.pairingCode}</code></span>
                </div>
                {copyError && <p className="settings-prose text-destructive" role="alert">{copyError}</p>}
              </div>
            )}
            {!pairing.loading && pairing.pairingCode && !pairing.joinCommand && (
              <p className="settings-prose mt-3" role="status">
                No public address is set. Set a reachable address in Access before adding another machine.
                {' '}<Button type="button" variant="link" size="sm" onClick={access}>Open Access</Button>
              </p>
            )}
            {!pairing.loading && pairing.error && <Button type="button" variant="outline" size="sm" className="mt-3" onClick={mint}>Try again</Button>}
          </div>
        </li>
        <li className="flex min-w-0 gap-4">
          <StepNumber number={3} complete={pairing.newMachine !== null} />
          <div className="min-w-0 flex-1">
            <h4 className="settings-h2">Wait for it to appear</h4>
            <p className="settings-prose mt-1">It shows up in the machine list on its own.</p>
            {pairing.newMachine ? (
              <div className="mt-3 space-y-3">
                <p className="settings-prose text-success" role="status">
                  <strong>{pairing.newMachine.name}</strong> is paired. That one-use command has been spent.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => {
                    if (!pairing.newMachine) return
                    openTakeover({title: pairing.newMachine.name,
                      content: <MachineDetail machineId={pairing.newMachine.id} />})
                  }}>View machine</Button>
                  <Button type="button" variant="ghost" size="sm" onClick={chooseAgain}>Add another machine</Button>
                </div>
              </div>
            ) : pairing.joinCommand && (
              <p className="settings-prose mt-3 flex items-center gap-2" role="status"><WorkingMark size={13} />Waiting for the machine…</p>
            )}
            {pairing.publicUrl && <div className="settings-prose mt-3 flex min-w-0 flex-wrap items-center gap-2">
              <span className="min-w-0 break-all">Connects to <code>{pairing.publicUrl}</code></span>
              <Button type="button" variant="link" size="sm" onClick={access}>Change address</Button>
            </div>}
          </div>
        </li>
      </>}
    </ol>
  )
})

function StepNumber({ number, complete }: { number: number; complete: boolean }) {
  return <span className="settings-micro flex size-7 shrink-0 items-center justify-center rounded-full border border-border text-muted-foreground" aria-hidden="true">
    {complete ? <Check size={13} /> : number}
  </span>
}
