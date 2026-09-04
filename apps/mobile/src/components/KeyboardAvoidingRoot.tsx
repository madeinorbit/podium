import type { ComponentProps } from 'react'
import { KeyboardAvoidingView } from 'react-native'

export function KeyboardAvoidingRoot({
  automaticOffset: _automaticOffset,
  ...props
}: ComponentProps<typeof KeyboardAvoidingView> & { automaticOffset?: boolean }) {
  return <KeyboardAvoidingView {...props} />
}
