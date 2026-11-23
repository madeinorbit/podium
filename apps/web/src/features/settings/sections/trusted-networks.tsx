import { CIDR_RANGE_MESSAGE, parseCidr } from '@podium/model/browser'
import type { PodiumSettings } from '@podium/runtime'
import { observer } from 'mobx-react-lite'
import { type FormEvent, type JSX, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Row, Section } from './shared'

/**
 * Which networks count as safe for credentials (credential management §8).
 * A daemon on another computer receives credentials only over `wss`, or from
 * an address inside one of these ranges: a private encrypted network such as a
 * VPN. An admin writes it; every change applies to connected machines at once.
 */
export const TrustedNetworksSection = observer(function TrustedNetworksSection({
  settings,
  patch,
}: {
  settings: PodiumSettings
  patch: (p: Partial<PodiumSettings>) => void
}): JSX.Element {
  const networks = settings.daemonLink?.trustedNetworks ?? []
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const write = (trustedNetworks: string[]) =>
    patch({ daemonLink: { ...settings.daemonLink, trustedNetworks } })

  const add = (event: FormEvent) => {
    event.preventDefault()
    const value = draft.trim()
    if (value === '') return
    if (parseCidr(value) === null) {
      setError(CIDR_RANGE_MESSAGE)
      return
    }
    if (!networks.includes(value)) write([...networks, value])
    setDraft('')
    setError(null)
  }

  return (
    <Section
      title="Trusted networks"
      hint="A machine on another computer receives credentials only over an encrypted (wss) connection. Add a private encrypted network, such as your VPN, to treat machines connecting from it as safe too. Unencrypted connections from other computers stop working after February 2027."
    >
      {networks.map((network) => (
        <Row key={network} label={network} setting="daemonLink.trustedNetworks">
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={`Remove ${network}`}
            onClick={() => write(networks.filter((other) => other !== network))}
          >
            Remove
          </Button>
        </Row>
      ))}
      <Row
        label="Add a network"
        description="A range such as 100.64.0.0/10 or fd7a:115c:a1e0::/48."
        setting="daemonLink.trustedNetworks"
        error={error}
      >
        <form className="flex items-center gap-2" onSubmit={add}>
          <Input
            aria-label="Network range"
            placeholder="192.168.1.0/24"
            value={draft}
            aria-invalid={error !== null || undefined}
            onChange={(event) => {
              setDraft(event.target.value)
              setError(null)
            }}
          />
          <Button type="submit" variant="outline">
            Add
          </Button>
        </form>
      </Row>
    </Section>
  )
})
