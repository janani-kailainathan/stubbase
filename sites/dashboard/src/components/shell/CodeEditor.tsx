import { useEffect, useRef } from 'react'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view'
import { useThemeStore } from '@/stores/theme'

const themeRules = {
  '&': { height: '100%', backgroundColor: 'var(--code-bg)', color: 'var(--code-fg)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
    fontSize: '13px',
    lineHeight: '1.6',
    overflow: 'auto',
  },
  '.cm-content': { padding: '16px 0', caretColor: 'var(--primary-ink)' },
  '.cm-gutters': {
    backgroundColor: 'var(--code-bg)',
    color: 'var(--faintest)',
    border: 'none',
    paddingLeft: '8px',
  },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--muted-foreground)' },
  '.cm-activeLine': { backgroundColor: 'var(--editor-active-line)' },
  '.cm-cursor': { borderLeftColor: 'var(--primary-ink)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--editor-selection)',
  },
  '.cm-selectionMatch': { backgroundColor: 'var(--editor-selection-weak)' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
    backgroundColor: 'var(--editor-selection)',
    outline: 'none',
    color: 'inherit',
  },
  '.cm-nonmatchingBracket': { color: 'var(--syntax-invalid)' },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--card)',
    border: '1px solid var(--border)',
    color: 'var(--subtle)',
    padding: '0 4px',
  },
  '.cm-lint-marker': { width: '0.8em', height: '0.8em' },
  '.cm-tooltip': {
    backgroundColor: 'var(--popover)',
    border: '1px solid var(--border)',
    borderRadius: '6px',
    color: 'var(--code-fg)',
    fontFamily: 'var(--font-mono)',
    fontSize: '12px',
  },
  '.cm-tooltip .cm-tooltip-arrow:after': { borderTopColor: 'var(--popover)' },
  '.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--font-mono)', maxHeight: '16em' },
  '.cm-tooltip-autocomplete > ul > li': { padding: '3px 8px', lineHeight: '1.5' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--editor-selection-weak)',
    color: 'var(--code-fg)',
  },
  '.cm-completionMatchedText': { textDecoration: 'none', color: 'var(--primary-ink)', fontWeight: '600' },
  '.cm-completionDetail': { color: 'var(--faint)', fontStyle: 'normal', marginLeft: '1.5em' },
  // Active snippet tab-stop.
  '.cm-snippetField': {
    backgroundColor: 'var(--editor-selection)',
    outline: '1px solid var(--primary-soft-border-strong)',
  },
  '.cm-panels': {
    backgroundColor: 'var(--background)',
    color: 'var(--code-fg)',
    borderTop: '1px solid var(--border)',
    fontFamily: 'var(--font-mono)',
    fontSize: '12px',
  },
  '.cm-panel input, .cm-panel button': {
    backgroundColor: 'var(--card)',
    color: 'var(--code-fg)',
  },
}

// Identical rules either way: every colour is a token that re-resolves on its
// own when the class on <html> changes. Only CodeMirror's own `dark` flag has to
// be swapped, which is what the compartment below is for.
const darkTheme = EditorView.theme(themeRules, { dark: true })
const lightTheme = EditorView.theme(themeRules, { dark: false })

/**
 * The editing surface every code editor in the dashboard shares: line numbers,
 * the active line, undo/redo, find (Mod-f), the theme, and keeping the document
 * and `value` in step. A language editor (JsonEditor, EnvTextEditor) passes its
 * own grammar, highlighting and tools as `extensions`, which must be a stable
 * value — the view is built once and never rebuilt. A language keymap that
 * should win over the defaults wraps itself in Prec.high.
 *
 * Only ever imported by lazily loaded editors, so CodeMirror stays out of the
 * initial bundle.
 */
export function CodeEditor({
  value,
  onChange,
  autoFocus = true,
  extensions,
}: {
  value: string
  onChange: (value: string) => void
  /** The file editors take focus on Edit; the playground's body field must not steal it. */
  autoFocus?: boolean
  extensions: Extension
}) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const themeMode = useThemeStore((s) => s.theme)
  // Reconfiguring through a compartment swaps the theme in place; rebuilding the
  // view would throw away the document's undo history and cursor.
  const themeSlot = useRef(new Compartment())
  const themeModeRef = useRef(themeMode)
  themeModeRef.current = themeMode
  // Kept in a ref so the editor is built once; a new onChange identity per
  // render must not tear down and rebuild the whole view.
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    const instance = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          extensions,
          history(),
          drawSelection(),
          highlightSelectionMatches(),
          themeSlot.current.of(themeModeRef.current === 'light' ? lightTheme : darkTheme),
          keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString())
          }),
        ],
      }),
    })
    view.current = instance
    if (autoFocus) instance.focus()
    return () => {
      instance.destroy()
      view.current = null
    }
    // Mount-once: `value` seeds the doc, later changes are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    view.current?.dispatch({
      effects: themeSlot.current.reconfigure(themeMode === 'light' ? lightTheme : darkTheme),
    })
  }, [themeMode])

  // Adopt external edits (e.g. the store reformatting the draft). Keystrokes
  // round-trip to the same string, so this is a no-op while typing.
  useEffect(() => {
    const instance = view.current
    if (!instance || value === instance.state.doc.toString()) return
    instance.dispatch({
      changes: { from: 0, to: instance.state.doc.length, insert: value },
    })
  }, [value])

  return <div ref={host} className="min-h-0 w-full flex-1 overflow-hidden bg-code-bg" />
}
