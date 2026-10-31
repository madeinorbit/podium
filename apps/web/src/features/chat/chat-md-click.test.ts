import { asSessionId } from '@podium/model'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const clickMocks = vi.hoisted(() => ({
  codeCopy: vi.fn(() => false),
  activateRef: vi.fn(),
}))

vi.mock('@/lib/code-copy', () => ({ handleCodeCopyClick: clickMocks.codeCopy }))
vi.mock('@/lib/ref-activation', () => ({ activateRef: clickMocks.activateRef }))

import { renderMarkdown } from '@/lib/markdown'
import { handleChatMdClick } from './chat-md-click'

function delegatedEvent(target: HTMLElement): {
  target: HTMLElement
  preventDefault: ReturnType<typeof vi.fn>
  metaKey: boolean
  ctrlKey: boolean
  clientX: number
  clientY: number
} {
  return {
    target,
    preventDefault: vi.fn(),
    metaKey: false,
    ctrlKey: false,
    clientX: 12,
    clientY: 34,
  }
}

beforeEach(() => {
  document.body.innerHTML = ''
  clickMocks.codeCopy.mockReset().mockReturnValue(false)
  clickMocks.activateRef.mockReset()
})

describe('chat Markdown click delegation', () => {
  it('gives code-copy buttons first refusal', () => {
    const target = document.createElement('button')
    const event = delegatedEvent(target)
    const openFile = vi.fn()
    clickMocks.codeCopy.mockReturnValue(true)

    handleChatMdClick(event as never, asSessionId('s1'), '/repo', openFile)

    expect(clickMocks.activateRef).not.toHaveBeenCalled()
    expect(openFile).not.toHaveBeenCalled()
  })

  it('activates a nested ref target and preserves click modifiers and position', () => {
    document.body.innerHTML = '<a class="ref-link" data-ref="POD-1407"><span>issue</span></a>'
    const target = document.querySelector('span') as HTMLElement
    const event = { ...delegatedEvent(target), metaKey: true }

    handleChatMdClick(event as never, asSessionId('s1'), '/repo', vi.fn())

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(clickMocks.activateRef).toHaveBeenCalledWith('POD-1407', event)
  })

  it('opens a nested relative file link against the session cwd', () => {
    document.body.innerHTML =
      '<a class="file-link" data-path="../shared/file.ts"><span>file</span></a>'
    const target = document.querySelector('span') as HTMLElement
    const event = delegatedEvent(target)
    const openFile = vi.fn()

    handleChatMdClick(event as never, asSessionId('s1'), '/repo/app', openFile)

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(openFile).toHaveBeenCalledWith(asSessionId('s1'), '/repo/shared/file.ts')
  })

  it('leaves ordinary and external links to their native behavior', () => {
    document.body.innerHTML = '<a href="https://example.com"><span>external</span></a>'
    const event = delegatedEvent(document.querySelector('span') as HTMLElement)

    handleChatMdClick(event as never, asSessionId('s1'), '/repo', vi.fn())

    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(clickMocks.activateRef).not.toHaveBeenCalled()
  })

  it('opens a Markdown link to an absolute file instead of navigating the app', () => {
    // How Codex links the files it wrote (ONA-31): a host-less absolute href
    // that, left to the browser, loads the Podium SPA again.
    document.body.innerHTML = renderMarkdown('[**review.html**](/home/me/site/docs/review.html)')
    const event = delegatedEvent(document.querySelector('strong') as HTMLElement)
    const openFile = vi.fn()

    handleChatMdClick(event as never, asSessionId('s1'), '/home/me/site', openFile)

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(openFile).toHaveBeenCalledWith(asSessionId('s1'), '/home/me/site/docs/review.html')
  })

  it('opens a relative Markdown link with a line suffix against the session cwd', () => {
    document.body.innerHTML = renderMarkdown('[ref](<references/tool ref.md:12>)')
    const event = delegatedEvent(document.querySelector('a') as HTMLElement)
    const openFile = vi.fn()

    handleChatMdClick(event as never, asSessionId('s1'), '/repo', openFile)

    expect(openFile).toHaveBeenCalledWith(asSessionId('s1'), '/repo/references/tool ref.md')
  })

  it.each([
    ['file:///repo/docs/a.md', '/repo/docs/a.md'],
    ['README.md:12', '/repo/README.md'],
  ])('keeps %s through the sanitizer and opens it', (href, path) => {
    document.body.innerHTML = renderMarkdown(`[x](${href})`)
    const event = delegatedEvent(document.querySelector('a') as HTMLElement)
    const openFile = vi.fn()

    handleChatMdClick(event as never, asSessionId('s1'), '/repo', openFile)

    expect(openFile).toHaveBeenCalledWith(asSessionId('s1'), path)
  })

  it('keeps a drive path through the sanitizer for a Windows session', () => {
    document.body.innerHTML = renderMarkdown('[x](C:/repo/a.md)')
    const event = delegatedEvent(document.querySelector('a') as HTMLElement)
    const openFile = vi.fn()

    handleChatMdClick(event as never, asSessionId('s1'), 'C:\\repo', openFile)

    expect(openFile).toHaveBeenCalledWith(
      asSessionId('s1'),
      expect.stringMatching(/^C:[\\/]repo[\\/]a\.md$/),
    )
  })

  it('leaves a link the desktop shell already handed off', () => {
    document.body.innerHTML = renderMarkdown('[x](/repo/a.md)')
    const event = {
      ...delegatedEvent(document.querySelector('a') as HTMLElement),
      defaultPrevented: true,
    }
    const openFile = vi.fn()

    handleChatMdClick(event as never, asSessionId('s1'), '/repo', openFile)

    expect(openFile).not.toHaveBeenCalled()
  })
})
