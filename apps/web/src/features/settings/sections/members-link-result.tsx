import { useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Row } from './shared'

export function MemberLinkResult({ label, url, notice }: { label: string; url: string; notice: string }) {
  const id = useId()
  const [copyNotice, setCopyNotice] = useState('')
  return (
    <div className="settings-list-note space-y-2" role="status">
      <p className="settings-prose">{copyNotice || notice}</p>
      <Row label={label}>
        <label className="sr-only" htmlFor={id}>{label}</label>
        <Input id={id} readOnly value={url} onFocus={(event) => event.target.select()} />
        <Button type="button" variant="outline" size="sm" onClick={async () => {
          try {
            await navigator.clipboard.writeText(url)
            setCopyNotice('Link copied.')
          } catch {
            setCopyNotice('Select the link above and copy it.')
          }
        }}>Copy link</Button>
      </Row>
    </div>
  )
}
