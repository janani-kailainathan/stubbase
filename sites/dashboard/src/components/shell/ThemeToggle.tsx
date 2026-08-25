import { Moon, Sun } from 'lucide-react'
import { useThemeStore } from '@/stores/theme'

/**
 * Light/dark switch. Shows the theme you would switch TO, which is the usual
 * reading of this control. Initial resolution happens in index.html before the
 * bundle loads; this only flips it from there.
 */
export function ThemeToggle() {
  const theme = useThemeStore((s) => s.theme)
  const toggle = useThemeStore((s) => s.toggle)

  return (
    <button
      onClick={toggle}
      title={theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme'}
      aria-label="Switch between light and dark theme"
      className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-subtle transition-colors hover:bg-card hover:text-heading"
    >
      {theme === 'light' ? <Moon className="h-3.5 w-3.5" /> : <Sun className="h-3.5 w-3.5" />}
    </button>
  )
}
