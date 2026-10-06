import { createPool } from './store'

/** A helper that reaches the store by value: importing it from a row is importing the store. */
export const usePool = () => createPool()
