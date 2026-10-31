import './test-support/no-message-attachments'
import type { ActivityDisclosureProps, ParsedEnvelope } from '@podium/client-core/values'
import { asSessionId } from '@podium/model'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { InboxReadRow, SentNoteRow } from './MailCommandRow'
import { MessageEnvelopeGroup } from './MessageEnvelopeGroup'
import { ToolBlock } from './ToolBlock'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const noop = () => {}
const envelope: ParsedEnvelope = {
  id: 'note',
  from: 'issue:POD-12',
  to: 'issue:POD-34',
  body: 'Review body',
  question: false,
  expectsReply: false,
}
const members: [string, (props: ActivityDisclosureProps) => ReactElement][] = [
  [
    'received note',
    (props) => <MessageEnvelopeGroup bare envelopes={[envelope]} onBodyClick={noop} {...props} />,
  ],
  [
    'sent note',
    (props) => (
      <SentNoteRow
        bare
        note={{ op: 'note', to: 'issue:POD-34', preview: 'Review body' }}
        fallbackId="sent"
        ts={undefined}
        onBodyClick={noop}
        {...props}
      />
    ),
  ],
  [
    'inbox read',
    (props) => (
      <InboxReadRow
        bare
        notes={2}
        result="Inbox listing"
        rowKey="inbox"
        ts={undefined}
        {...props}
      />
    ),
  ],
  [
    'tool',
    (props) => (
      <ToolBlock
        block={{
          item: {
            id: 'tool',
            role: 'tool',
            text: '',
            toolName: 'Bash',
            toolInput: 'git status',
            toolResult: 'Clean tree',
          },
        }}
        sessionId={asSessionId('session')}
        cwd="/repo"
        openFile={noop}
        {...props}
      />
    ),
  ],
]
let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

it.each(
  members,
)('%s preserves an owner-opened singleton well as ordinary member intent', (_name, member) => {
  act(() => root.render(member({ initialOpen: true })))
  const body = host.querySelector('.mail-item-body, .tool-result-full')
  expect(body).not.toBeNull()
  act(() => root.render(member({ initialOpen: false })))
  expect(host.querySelector('.mail-item-body, .tool-result-full')).toBe(body)
  act(() => host.querySelector<HTMLButtonElement>('button')!.click())
  expect(host.querySelector<HTMLElement>('[data-open]')?.dataset.open).toBe('false')
})

it.each(members)('%s shares temporary force-open and retained user disclosure', (_name, member) => {
  const changes: boolean[] = []
  const render = (forceOpen: boolean) =>
    act(() => root.render(member({ forceOpen, onOpenChange: (open) => changes.push(open) })))
  const row = () => host.querySelector<HTMLElement>('[data-open]')!
  const toggle = () => act(() => host.querySelector<HTMLButtonElement>('button')!.click())
  const body = () => host.querySelector('.mail-item-body, .tool-result-full')
  render(true)
  expect(row().dataset.open).toBe('true')
  expect(changes).toEqual([])
  render(false)
  expect(row().dataset.open).toBe('false')
  expect(changes).toEqual([])
  toggle()
  expect(row().dataset.open).toBe('true')
  expect(row().hasAttribute('data-transcript-retain')).toBe(true)
  const openedBody = body()
  expect(openedBody).not.toBeNull()
  render(true)
  render(false)
  expect(body()).toBe(openedBody)
  expect(changes).toEqual([true])
  toggle()
  expect(row().dataset.open).toBe('false')
  expect(changes).toEqual([true, false])
})

it.each(members)('%s reports explicit intent while force-open pins it open', (_name, member) => {
  const changes: boolean[] = []
  const render = (forceOpen: boolean) =>
    act(() => root.render(member({ forceOpen, onOpenChange: (open) => changes.push(open) })))
  const toggle = () => act(() => host.querySelector<HTMLButtonElement>('button')!.click())
  render(true)
  toggle()
  expect(changes).toEqual([true])
  toggle()
  expect(changes).toEqual([true, false])
  expect(host.querySelector<HTMLElement>('[data-open]')?.dataset.open).toBe('true')
  render(false)
  expect(host.querySelector<HTMLElement>('[data-open]')?.dataset.open).toBe('false')
})
