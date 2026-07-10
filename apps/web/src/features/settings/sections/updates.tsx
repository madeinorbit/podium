import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { useStoreSelector } from '@/app/store'
import { Button } from '@/components/ui/button'
import { Row, Section } from './shared'

/** Self-update channel selector. Persists immediately via the setup tRPC (not part of
 *  the settings blob) — mirroring AppearanceSection, which also applies on its own. The
 *  channel type is inlined so the web bundle never imports @podium/runtime (node:fs). */
export function UpdatesSection(): JSX.Element {
  const trpc = useStoreSelector((s) => s.trpc)
  const [channel, setChannel] = useState<'stable' | 'edge' | null>(null)
  const [channelError, setChannelError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    trpc.setup.channel
      .query()
      .then((c) => {
        if (!cancelled) setChannel(c)
      })
      .catch((e) => {
        if (!cancelled) setChannelError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [trpc])

  const choose = async (next: 'stable' | 'edge') => {
    if (next === channel) return
    const prev = channel
    setChannelError(null)
    setChannel(next) // optimistic
    try {
      setChannel(await trpc.setup.setChannel.mutate({ channel: next }))
    } catch (e) {
      setChannel(prev)
      setChannelError(e instanceof Error ? e.message : String(e))
    }
  }

  const options: { value: 'stable' | 'edge'; label: string }[] = [
    { value: 'stable', label: 'Stable' },
    { value: 'edge', label: 'Edge' },
  ]

  return (
    <Section
      title="Updates"
      hint="Which builds the self-updater (podium update) pulls. stable = released builds · edge = latest from main."
    >
      <Row label="Update channel">
        {channel === null ? (
          <span className="text-muted-foreground text-xs">Loading…</span>
        ) : (
          <div className="flex gap-1">
            {options.map((o) => (
              <Button
                key={o.value}
                type="button"
                size="sm"
                variant={channel === o.value ? 'default' : 'outline'}
                aria-pressed={channel === o.value}
                onClick={() => void choose(o.value)}
              >
                {o.label}
              </Button>
            ))}
          </div>
        )}
      </Row>
      {channelError && <p className="text-destructive text-xs">{channelError}</p>}
    </Section>
  )
}
