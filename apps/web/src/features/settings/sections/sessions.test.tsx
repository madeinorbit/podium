import { DEFAULT_SETTINGS } from '@podium/runtime'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { modelCatalogFixture } from '@/test-support/model-catalog-mock'
import { SessionsSection } from './sessions'

vi.mock('@/app/store', () => ({ useRuntimeSelector: () => ({}) }))
afterEach(() => { cleanup(); modelCatalogFixture.current = {} })

it('accepts a typed subagent model in Settings when no models are reported', async () => {
  const patch = vi.fn()
  render(<SessionsSection settings={DEFAULT_SETTINGS} accounts={[]} patch={patch} />)
  const models = screen.getAllByRole('button', { name: 'Model' })
  fireEvent.click(models[models.length - 1]!)
  fireEvent.change(await screen.findByPlaceholderText('Model name…'), { target: { value: 'managed-custom-model' } })
  fireEvent.click(screen.getByRole('menuitem', { name: /Use “managed-custom-model”/ }))
  expect(patch).toHaveBeenCalledWith(expect.objectContaining({ roles: expect.objectContaining({
    coding: expect.objectContaining({ subagentModel: 'managed-custom-model' }),
  }) }))
})
