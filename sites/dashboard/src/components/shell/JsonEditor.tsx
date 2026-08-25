import { useEffect, useRef } from 'react'
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { json, jsonParseLinter } from '@codemirror/lang-json'
import {
  HighlightStyle,
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from '@codemirror/language'
import { lintGutter, linter, lintKeymap } from '@codemirror/lint'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { Compartment, EditorState } from '@codemirror/state'
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view'
import { tags as t } from '@lezer/highlight'
import { jsonRecordCompletions } from '@/lib/json-completion'
import { useThemeStore } from '@/stores/theme'

/**
 * Token colours come from the same --syntax-* tokens as src/lib/json-highlight.tsx
 * (the read-only renderer), so flipping into edit mode doesn't recolour the
 * document under the cursor — and both follow the theme without extra wiring,
 * since CSS variables re-resolve live.
 */
const highlight = HighlightStyle.define([
  { tag: t.propertyName, color: 'var(--syntax-key)' }, // emerald-400 — keys
  { tag: [t.string, t.special(t.string)], color: 'var(--syntax-str)' }, // sky-300
  { tag: t.number, color: 'var(--syntax-num)' }, // amber-300
  { tag: [t.bool, t.null, t.keyword], color: 'var(--syntax-bool)' }, // purple-400
  { tag: [t.separator, t.brace, t.squareBracket, t.punctuation], color: 'var(--syntax-punct)' }, // zinc-500
  { tag: t.invalid, color: 'var(--syntax-invalid)' }, // rose-400
])

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
 * JSON editing surface: line numbers, folding, bracket matching/auto-close,
 * Tab-to-indent, undo/redo, find (Mod-f) and a live parse linter that marks the
 * offending line instead of waiting for Save to reject the whole document.
 *
 * Loaded lazily (see EditorPane) — CodeMirror stays out of the initial bundle.
 */
export function JsonEditor({
  value,
  onChange,
}: {
  value: string
  onChange: (value: string) => void
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
          foldGutter(),
          lintGutter(),
          history(),
          drawSelection(),
          indentOnInput(),
          indentUnit.of('  '),
          bracketMatching(),
          closeBrackets(),
          highlightSelectionMatches(),
          json(),
          autocompletion({ override: [jsonRecordCompletions], icons: false }),
          linter(jsonParseLinter()),
          syntaxHighlighting(highlight),
          themeSlot.current.of(themeModeRef.current === 'light' ? lightTheme : darkTheme),
          keymap.of([
            ...closeBracketsKeymap,
            ...completionKeymap,
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
            ...foldKeymap,
            ...lintKeymap,
            indentWithTab,
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString())
          }),
        ],
      }),
    })
    view.current = instance
    instance.focus()
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

export default JsonEditor
