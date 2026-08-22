import { useEffect, useRef } from 'react'

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent)

/** Rendered next to the Save button so the shortcut is discoverable. */
export const SAVE_HINT = isMac ? '⌘S' : 'Ctrl+S'

/**
 * ⌘S / Ctrl-S saves the open editor.
 *
 * Bound on the document rather than on the editor element, so it fires with the
 * focus anywhere in the pane — including the CodeMirror instance, which has no
 * binding of its own for it. While an editor is open the event is always
 * consumed, otherwise the browser's own "save page" dialog opens over the app.
 */
export function useSaveShortcut(enabled: boolean, onSave: () => void) {
  // Kept in a ref: `onSave` closes over the current draft and so changes every
  // keystroke, which would otherwise rebind the listener each time.
  const save = useRef(onSave)
  save.current = onSave

  useEffect(() => {
    if (!enabled) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 's' || e.shiftKey || e.altKey) return
      if (!(isMac ? e.metaKey : e.ctrlKey)) return
      e.preventDefault()
      save.current()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [enabled])
}
