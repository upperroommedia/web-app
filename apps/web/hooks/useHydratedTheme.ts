import { useSyncExternalStore } from 'react';

const subscribe = () => () => undefined;
const clientSnapshot = () => true;
const serverSnapshot = () => false;

/** Keep SSR and its first hydration render identical, then apply the user's theme.
 * This changes only the theme; page content remains available in server HTML.
 */
export function useHydratedTheme(resolvedTheme: string | undefined): 'light' | 'dark' {
  const hydrated = useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot);
  return hydrated && resolvedTheme === 'light' ? 'light' : 'dark';
}
