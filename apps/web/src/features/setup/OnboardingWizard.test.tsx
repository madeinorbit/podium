// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Trpc } from '@/app/trpc'
import { ActivationResumeBar } from './ActivationShell'
import { OnboardingWizard } from './OnboardingWizard'
import type { ConfirmedVpsActivation } from './use-vps-activation'

const scan = vi.hoisted(() => ({ props: null as null | Record<string, unknown> }))

vi.mock('./RepoScanFlow', () => ({
  RepoScanFlow: (props: Record<string, unknown>) => {
    scan.props = props
    return (
      <div data-testid="repo-scan-flow">
        {props.intro as React.ReactNode}
        <button type="button" onClick={() => (props.onClose as () => void)()}>
          Close browser
        </button>
        <button type="button" onClick={() => (props.onDone as (count: number) => void)(1)}>
          Finish scan
        </button>
      </div>
    )
  },
}))

afterEach(() => {
  cleanup()
  scan.props = null
  vi.clearAllMocks()
})

function vpsController(overrides: Partial<ConfirmedVpsActivation> = {}): ConfirmedVpsActivation {
  return {
    state: null,
    ready: true,
    saving: false,
    error: null,
    persist: vi.fn(),
    clear: vi.fn(),
    ...overrides,
  }
}

function trpc(): Trpc {
  return {
    setup: {
      connect: { mutate: vi.fn() },
      join: { mutate: vi.fn() },
    },
  } as unknown as Trpc
}

describe('OnboardingWizard activation routes', () => {
  it('starts on a shell-native welcome surface with a prominent exploration exit', () => {
    const onRouteChange = vi.fn()
    const onExplore = vi.fn()
    const onEnterVps = vi.fn().mockResolvedValue(undefined)
    render(
      <OnboardingWizard
        route="welcome"
        onRouteChange={onRouteChange}
        onExplore={onExplore}
        onComplete={() => {}}
        onConnectionConfigured={vi.fn()}
        onEnterVps={onEnterVps}
        trpc={trpc()}
        vps={vpsController()}
      />,
    )

    expect(screen.getByRole('heading', { name: /Start locally/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Set up a VPS' }))
    expect(onEnterVps).toHaveBeenCalledWith('welcome')
    fireEvent.click(screen.getByRole('button', { name: 'Find local projects' }))
    expect(onRouteChange).toHaveBeenCalledWith('local-project')
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect(onRouteChange).toHaveBeenCalledWith('existing-podium')
    fireEvent.click(screen.getByRole('button', { name: /Explore Podium/ }))
    expect(onExplore).toHaveBeenCalledOnce()
  })

  it('composes the existing repo flow and keeps explore, back, and completion explicit', () => {
    const onRouteChange = vi.fn()
    const onExplore = vi.fn()
    const onComplete = vi.fn()
    const onEnterVps = vi.fn().mockResolvedValue(undefined)
    render(
      <OnboardingWizard
        route="local-project"
        onRouteChange={onRouteChange}
        onExplore={onExplore}
        onComplete={onComplete}
        onConnectionConfigured={vi.fn()}
        onEnterVps={onEnterVps}
        trpc={trpc()}
        vps={vpsController()}
      />,
    )

    expect(screen.getByTestId('repo-scan-flow')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Connect to existing Podium/ }))
    expect(onRouteChange).toHaveBeenCalledWith('existing-podium')
    fireEvent.click(screen.getByRole('button', { name: /Set up an always-on VPS/ }))
    expect(onEnterVps).toHaveBeenCalledWith('local-project')
    fireEvent.click(screen.getByRole('button', { name: /Explore Podium/ }))
    expect(onExplore).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Close browser' }))
    expect(onRouteChange).toHaveBeenCalledWith('welcome')
    fireEvent.click(screen.getByRole('button', { name: 'Finish scan' }))
    expect(onRouteChange).toHaveBeenCalledWith('agent')
    expect(onComplete).not.toHaveBeenCalled()
  })

  it('offers an accessible durable resume action', () => {
    const onResume = vi.fn()
    render(<ActivationResumeBar routeLabel="local projects" onResume={onResume} />)

    expect(screen.getByLabelText('Resume Podium activation').textContent).toContain(
      'Continue at local projects',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Resume activation' }))
    expect(onResume).toHaveBeenCalledOnce()
  })
})
