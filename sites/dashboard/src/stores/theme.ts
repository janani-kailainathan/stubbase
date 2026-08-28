import { create } from 'zustand'
import { writeThemeCookie } from '@/lib/cross-site'

export type Theme = 'light' | 'dark'

const STORAGE_KEY = 'stubbase-theme'

/**
 * Theme state. The *initial* resolution happens in index.html, before the bundle
 * loads, so the shell never paints in the wrong theme — this store adopts
 * whatever that script decided rather than re-deriving it. Keep the storage key
 * and the class names in step with that script.
 *
 * Not `persist()`-wrapped: the pre-paint script has to read the value with plain
 * localStorage anyway, so a single explicit key is simpler than matching
 * zustand's envelope format from a script that runs before zustand exists.
 *
 * Every write goes to *two* stores. localStorage is the origin-local copy the
 * pre-paint script prefers; the cookie is the copy the landing site can read,
 * since it lives on another origin (see lib/cross-site.ts). Writing both is
 * what makes the choice follow a visitor across stubbase.dev and this app.
 */
function currentTheme(): Theme {
  return document.documentElement.classList.contains('light') ? 'light' : 'dark'
}

function apply(theme: Theme) {
  const root = document.documentElement
  root.classList.remove('light', 'dark')
  root.classList.add(theme)
  document
    .getElementById('theme-color')
    ?.setAttribute('content', theme === 'light' ? '#FAFAFA' : '#09090B')
  try {
    localStorage.setItem(STORAGE_KEY, theme)
  } catch {
    // Choice will not survive a reload; the toggle still works this session.
  }
  writeThemeCookie(theme) // …and the copy the landing site reads
}

interface ThemeState {
  theme: Theme
  setTheme: (theme: Theme) => void
  toggle: () => void
}

export const useThemeStore = create<ThemeState>()((set, get) => ({
  theme: currentTheme(),
  setTheme: (theme) => {
    apply(theme)
    set({ theme })
  },
  toggle: () => get().setTheme(get().theme === 'light' ? 'dark' : 'light'),
}))
