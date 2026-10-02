import { createContext, useContext } from 'react'

export const AccountContext = createContext<{ signOut(): Promise<void> } | null>(null)
export const useAccount = () => useContext(AccountContext)
