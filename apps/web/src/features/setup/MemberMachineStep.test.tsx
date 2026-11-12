import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react'
import { type ReactNode, useContext } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A MEMBER WHO JOINED SOMEONE ELSE'S SERVER (POD-6882).
 *
 * Alice installed the server and works on its machine. Bob accepted her
 * invitation and can see none of her work. The server says which of them sets
 * the server up (`/auth/admin/viewer`); Bob, with no machine to run on, is
 * offered the machine step in the workspace rather than first-run setup.
 */
const client = vi.hoisted(() => ({ setView: vi.fn(), setSettingsTab: vi.fn() }))
const catalog = vi.hoisted(() => ({ machines: [] as Record<string, unknown>[] }))

vi.mock('@/features/settings/stable-access', () => ({ useSettingsClient: () => client }))
vi.mock('@/features/settings/readers', () => ({
  useSettingsCatalog: () => ({ repos: [], machines: catalog.machines }),
}))

import { AdminViewerContext, useAdminSections } from '@/features/settings/admin-viewer'
import { MemberMachineStep, useNeedsMemberMachine } from './MemberMachineStep'

/** Alice's machine as Bob's catalog shows it once the server scopes `use`. */
const ALICE_MACHINE = { id: 'machine-alice', name: 'vega', online: true, use: 'denied' }

function viewerAnswers(answer: Record<string, unknown> | 'unavailable') {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url.endsWith('/auth/admin/viewer') && answer !== 'unavailable'
        ? { ok: true, status: 200, json: async () => answer }
        : { ok: false, status: 500, json: async () => ({ error: 'down' }) },
    ),
  )
}

/** The shell's one shared viewer read, as AppShell provides it. */
function SharedViewer({ children }: { children: ReactNode }) {
  return (
    <AdminViewerContext.Provider value={useAdminSections()}>{children}</AdminViewerContext.Provider>
  )
}

async function needsMachineStep(): Promise<boolean> {
  const hook = renderHook(
    () => ({ needs: useNeedsMemberMachine(), viewer: useContext(AdminViewerContext) }),
    { wrapper: SharedViewer },
  )
  await waitFor(() => expect(hook.result.current.viewer?.status).not.toBe('loading'))
  return hook.result.current.needs
}

beforeEach(() => {
  catalog.machines = [ALICE_MACHINE]
  client.setView.mockReset()
  client.setSettingsTab.mockReset()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('the viewer answer: who sets this server up', () => {
  it('reads the server fact, and keeps older servers and failed reads on the old behaviour', async () => {
    viewerAnswers({ sections: [], capabilities: { setUpServer: false } })
    const bob = renderHook(() => useAdminSections())
    await waitFor(() => expect(bob.result.current.status).toBe('ready'))
    expect(bob.result.current.capabilities).toEqual({ addMachine: false, setUpServer: false })

    viewerAnswers({ sections: ['machines'] })
    const older = renderHook(() => useAdminSections())
    await waitFor(() => expect(older.result.current.status).toBe('ready'))
    expect(older.result.current.capabilities).toEqual({ addMachine: false, setUpServer: true })

    viewerAnswers('unavailable')
    const failed = renderHook(() => useAdminSections())
    await waitFor(() => expect(failed.result.current.status).toBe('error'))
    expect(failed.result.current.capabilities).toEqual({ addMachine: false, setUpServer: true })
  })
})

describe('two members: Alice set the server up, Bob joined it', () => {
  it('offers Bob, with no machine of his own, the machine step', async () => {
    viewerAnswers({ sections: [], capabilities: { setUpServer: false } })
    expect(await needsMachineStep()).toBe(true)
  })

  it('asks nothing of the server outside the shell that shares the answer', () => {
    viewerAnswers({ sections: [], capabilities: { setUpServer: false } })
    const hook = renderHook(() => useNeedsMemberMachine())
    expect(hook.result.current).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('never offers it to Alice, or to a one-person server', async () => {
    viewerAnswers({
      sections: ['people', 'access', 'machines', 'instance', 'audit'],
      capabilities: { setUpServer: true, addMachine: true },
    })
    catalog.machines = []
    expect(await needsMachineStep()).toBe(false)
  })

  it('stops once Bob may use a machine', async () => {
    viewerAnswers({ sections: [], capabilities: { setUpServer: false } })
    catalog.machines = [
      ALICE_MACHINE,
      { id: 'machine-bob', name: 'laptop', online: false, use: 'granted' },
    ]
    expect(await needsMachineStep()).toBe(false)
  })

  it('tells a member that an admin adds machines, and opens Settings › Machines', async () => {
    viewerAnswers({ sections: [], capabilities: { setUpServer: false } })
    render(<MemberMachineStep />)
    expect(screen.getByRole('heading', { name: 'Add your machine' })).toBeTruthy()
    expect(screen.getByText(/an admin adds them/)).toBeTruthy()
    const open = await screen.findByRole('button', { name: 'Open Machines' })
    await act(async () => fireEvent.click(open))
    expect(client.setSettingsTab).toHaveBeenCalledWith('machines')
    expect(client.setView).toHaveBeenCalledWith('settings')
  })

  it('gives someone the server lets add a machine the install command route', async () => {
    viewerAnswers({ sections: [], capabilities: { setUpServer: false, addMachine: true } })
    render(<MemberMachineStep />)
    expect(await screen.findByRole('button', { name: 'Add a machine' })).toBeTruthy()
    expect(screen.getByText(/one-line install command/)).toBeTruthy()
  })
})
