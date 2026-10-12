import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { modelCatalogFixture } from '@/test-support/model-catalog-mock'
import { AllConnectorsModelPicker, EffortPicker, ModelPicker } from './ModelEffortPicker'

const LIVE_CATALOG: typeof modelCatalogFixture.current = {
  grok: [
    { value: 'grok-4.5', label: 'grok-4.5' },
    { value: 'grok-composer-2.5-fast', label: 'grok-composer-2.5-fast' },
  ],
  'claude-code': [
    { value: 'claude-opus-4-8', label: 'Opus 4.8', efforts: ['low', 'high', 'xhigh'] },
    { value: 'claude-haiku-4-5', label: 'Haiku 4.5', efforts: [] },
  ],
}

beforeEach(() => {
  modelCatalogFixture.current = LIVE_CATALOG
})

afterEach(() => {
  cleanup()
  modelCatalogFixture.current = {}
})

describe('ModelPicker live catalog', () => {
  it('shows the agent CLI models supplied by the live catalog', async () => {
    render(<ModelPicker agentKind="grok" value="auto" onChange={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Model' }))
    // Live models from the server, not a static grok fallback entry.
    expect(await screen.findByRole('menuitem', { name: 'grok-4.5' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'grok-composer-2.5-fast' })).toBeTruthy()
  })

  it('selecting a live model reports its value', async () => {
    const onChange = vi.fn()
    render(<ModelPicker agentKind="grok" value="auto" onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Model' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'grok-composer-2.5-fast' }))
    expect(onChange).toHaveBeenCalledWith('grok-composer-2.5-fast')
  })
})

describe('ModelPicker without a live catalog (POD-3911)', () => {
  it('offers only Auto and says the machine has not reported its models', async () => {
    modelCatalogFixture.current = {}
    render(<ModelPicker agentKind="claude-code" value="auto" onChange={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Model' }))
    expect(await screen.findByRole('menuitem', { name: 'Auto' })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: 'Opus' })).toBeNull()
    expect(screen.getByText(/has not reported its models/)).toBeTruthy()
  })
})

describe('ModelPicker without typed models (POD-3911)', () => {
  it('offers no "Use …" entry for a typed name when free text is off', async () => {
    render(
      <ModelPicker agentKind="grok" value="auto" onChange={vi.fn()} allowFreeText={false} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Model' }))
    fireEvent.change(await screen.findByPlaceholderText('Filter…'), {
      target: { value: 'my-custom-model' },
    })
    expect(screen.queryByRole('menuitem', { name: /Use “my-custom-model”/ })).toBeNull()
  })

  it('still offers it where free text is on', async () => {
    render(<ModelPicker agentKind="grok" value="auto" onChange={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Model' }))
    fireEvent.change(await screen.findByPlaceholderText('Model name…'), {
      target: { value: 'my-custom-model' },
    })
    expect(screen.getByRole('menuitem', { name: /Use “my-custom-model”/ })).toBeTruthy()
  })
})

describe('EffortPicker follows the selected model', () => {
  // POD-3911: under an Auto model nobody knows which model will run, so nobody
  // knows its efforts. The pill stays, reads Auto, and offers nothing.
  it('reads Auto and offers no ladder while the model is auto', () => {
    render(<EffortPicker agentKind="claude-code" model="auto" value="auto" onChange={vi.fn()} />)
    const pill = screen.getByRole('button', { name: 'Effort' }) as HTMLButtonElement
    expect(pill.textContent).toContain('Auto')
    expect(pill.disabled).toBe(true)
    fireEvent.click(pill)
    expect(screen.queryByRole('menuitem', { name: 'Max' })).toBeNull()
  })

  it("shows the selected model's per-model effort levels", async () => {
    render(
      <EffortPicker
        agentKind="claude-code"
        model="claude-opus-4-8"
        value="auto"
        onChange={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Effort' }))
    expect(await screen.findByRole('menuitem', { name: 'Extra high' })).toBeTruthy()
    // opus-4-8's live efforts are [low,high,xhigh] → no "Max" option.
    expect(screen.queryByRole('menuitem', { name: 'Max' })).toBeNull()
  })

  it('reads Auto, inert, for a model that supports no effort (efforts: [])', () => {
    render(
      <EffortPicker
        agentKind="claude-code"
        model="claude-haiku-4-5"
        value="auto"
        onChange={vi.fn()}
      />,
    )
    const pill = screen.getByRole('button', { name: 'Effort' }) as HTMLButtonElement
    expect(pill.textContent).toContain('Auto')
    expect(pill.disabled).toBe(true)
  })

  it('is absent for a harness with no effort flag at all', () => {
    render(<EffortPicker agentKind="cursor" model="auto" value="auto" onChange={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Effort' })).toBeNull()
  })
})

describe('AllConnectorsModelPicker', () => {
  it('lists models from every connector and reports both harness and model', async () => {
    const onChange = vi.fn()
    render(<AllConnectorsModelPicker agentKind={undefined} value="auto" onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Model' }))
    expect(await screen.findByText('Claude Code')).toBeTruthy()
    // Only harnesses the machine reported models for (POD-3911): no Codex here.
    expect(screen.queryByText('Codex')).toBeNull()
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Opus 4.8' }))
    expect(onChange).toHaveBeenCalledWith({ agentKind: 'claude-code', model: 'claude-opus-4-8' })
  })
})
