import { asSessionId } from '@podium/model'
import { cleanup, render } from '@testing-library/react'
import type { JSX } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Dialog, DialogContent } from '@/components/ui/dialog'

// The real panel opens a terminal against the live store; this dialog's contract
// is about what happens AROUND it, so a marker stands in for the whole thing.
vi.mock('@/features/terminal/AgentPanel', () => ({
  AgentPanel: () => <div data-testid="agent-panel" />,
}))

const { SetupLoginTerminalDialog } = await import('./SetupLoginTerminalDialog')

afterEach(cleanup)

/**
 * The surfaces a native login actually finishes through — BrowserOpenOverlay's
 * pending-login card and the sonner toaster — are body children OUTSIDE this
 * dialog's portal. Base UI's modal mode marks every such sibling `inert` (or
 * `aria-hidden` where `inert` is unsupported), which no z-index can outrank.
 */
function outsideSurface(): HTMLElement {
  const node = document.createElement('div')
  node.dataset.testid = 'outside-surface'
  document.body.append(node)
  return node
}

function blocked(node: HTMLElement): boolean {
  return node.hasAttribute('inert') || node.getAttribute('aria-hidden') === 'true'
}

describe('SetupLoginTerminalDialog', () => {
  it('leaves the browser-open surfaces interactive while the login terminal is open', () => {
    const outside = outsideSurface()
    render(<SetupLoginTerminalDialog sessionId={asSessionId('login-1')} onClose={() => {}} />)
    expect(blocked(outside)).toBe(false)
  })

  // POSITIVE CONTROL. Without this the assertion above passes just as happily
  // against a rig that never marks anything — which is the failure mode that let
  // the modal login dialog ship. Same primitives, default modality, and the
  // outside surface must go inert.
  it('is marked inert by the same primitives at their default modality', () => {
    const outside = outsideSurface()
    function ModalPeer(): JSX.Element {
      return (
        <Dialog open>
          <DialogContent>peer</DialogContent>
        </Dialog>
      )
    }
    render(<ModalPeer />)
    expect(blocked(outside)).toBe(true)
  })
})
