import type { NativeStackNavigationOptions } from 'expo-router'
import type { ReactElement } from 'react'

/** Delivery notices belong to their message and Work row. Stack layouts must
 * not put a floating notice over another conversation or the native header. */
export function noticeScreenLayout({
  children,
}: {
  route: { name: string }
  options: NativeStackNavigationOptions
  children: ReactElement
}) {
  return children
}
