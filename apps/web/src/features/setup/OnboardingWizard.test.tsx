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

    expect(screen.getByRole('heading', { name: 'How do you want to start?' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Add a VPS' }))
    expect(onEnterVps).toHaveBeenCalledWith('welcome')
    fireEvent.click(screen.getByRole('button', { name: 'Choose a project' }))
    expect(onRouteChange).toHaveBeenCalledWith('local-project')
    fireEvent.click(screen.getByRole('button', { name: 'View connection options' }))
    expect(onRouteChange).toHaveBeenCalledWith('existing-podium')
    fireEvent.click(screen.getByRole('button', { name: /Explore Podium/ }))
    expect(onExplore).toHaveBeenCalledOnce()
  })

  it('opens repository intake without repeating the welcome actions', () => {
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
    expect(scan.props?.onboarding).toBe(true)
    expect(screen.queryByRole('button', { name: /existing Podium/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /VPS/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /Explore Podium/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Close browser' }))
    expect(onRouteChange).toHaveBeenCalledWith('welcome')
    fireEvent.click(screen.getByRole('button', { name: 'Finish scan' }))
    expect(onRouteChange).toHaveBeenCalledWith('agent')
    expect(onComplete).not.toHaveBeenCalled()
    expect(onEnterVps).not.toHaveBeenCalled()
    expect(onExplore).not.toHaveBeenCalled()
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
