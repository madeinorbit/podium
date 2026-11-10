import type { CatalogOption } from '@podium/client-core/agent-models'
import { type ReactElement, useState } from 'react'
import { ActionSheet } from './ActionSheet'

export interface ComposerModelMenuProps {
  models: readonly CatalogOption[]
  model: string
  /** Empty when the live driver does not take effort: no Effort row. */
  efforts: readonly CatalogOption[]
  effort: string
  effortLabel: string
  onModel: (value: string) => void
  onEffort: (value: string) => void
  children: (onPress: (() => void) | undefined) => ReactElement
}

/**
 * Android and web: the model list as a sheet, with Effort as its last row
 * opening a second sheet. iOS resolves the sibling file, a SwiftUI menu.
 */
export function ComposerModelMenu({
  models,
  model,
  efforts,
  effort,
  effortLabel,
  onModel,
  onEffort,
  children,
}: ComposerModelMenuProps) {
  const [step, setStep] = useState<'model' | 'effort' | null>(null)
  const close = () => setStep(null)
  return (
    <>
      {children(() => setStep('model'))}
      <ActionSheet
        visible={step === 'model'}
        title="Model"
        actions={[
          ...models.map((option) => ({
            label: option.label,
            selected: option.value === model,
            onPress: () => onModel(option.value),
          })),
          ...(efforts.length > 0
            ? [{ label: 'Effort', meta: effortLabel, onPress: () => setStep('effort') }]
            : []),
        ]}
        onClose={() => setStep((current) => (current === 'model' ? null : current))}
      />
      <ActionSheet
        visible={step === 'effort'}
        title="Effort"
        actions={efforts.map((option) => ({
          label: option.label,
          selected: option.value === effort,
          onPress: () => onEffort(option.value),
        }))}
        onClose={close}
      />
    </>
  )
}
