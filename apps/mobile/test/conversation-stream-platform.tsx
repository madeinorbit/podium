/** Fixed routing/profile adapters; transcript, Markdown and composer stay real. */
import { createContext } from 'react'
import { useRouter, useServerProfile } from './inbox-platform'
export * from './inbox-platform'
export const router = useRouter()
export const useOptionalServerProfile = useServerProfile
export const ServerProfileContext = createContext(useServerProfile())
