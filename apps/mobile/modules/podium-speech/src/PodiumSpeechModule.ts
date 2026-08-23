import { NativeModule, requireOptionalNativeModule } from 'expo'

import type { PodiumSpeechAvailability, PodiumSpeechModuleEvents } from './PodiumSpeech.types'

export declare class PodiumSpeechNativeModule extends NativeModule<PodiumSpeechModuleEvents> {
  getAvailability(localeIdentifier?: string): Promise<PodiumSpeechAvailability>
  start(localeIdentifier: string | undefined, clientGeneration: number): Promise<PodiumSpeechAvailability>
  stop(clientGeneration: number): Promise<void>
  cancel(clientGeneration: number): Promise<void>
}

/**
 * Optional by design. The Swift module exists only in a rebuilt native iOS app,
 * so Expo Go, Android, and web can import the adapter without crashing. Those
 * runtimes report unsupported and leave the text composer usable.
 */
export default requireOptionalNativeModule<PodiumSpeechNativeModule>('PodiumSpeech')
