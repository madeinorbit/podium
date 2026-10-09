/** Navigation chrome only; phone list components and their virtualizers stay real. */
export * from './conversation-stream-platform'
export const Stack = { Screen: () => null }
const navigation = { addListener: () => () => {}, setOptions: () => {}, isFocused: () => true }
export const useNavigation = () => navigation
