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
import { EditorState } from '@codemirror/state'
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

/**
 * Token colours mirror src/lib/json-highlight.tsx (the read-only renderer), so
 * flipping into edit mode doesn't recolour the document under the cursor.
 */
const highlight = HighlightStyle.define([
  { tag: t.propertyName, color: '#34d399' }, // emerald-400 — keys
  { tag: [t.string, t.special(t.string)], color: '#7dd3fc' }, // sky-300
  { tag: t.number, color: '#fcd34d' }, // amber-300
  { tag: [t.bool, t.null, t.keyword], color: '#c084fc' }, // purple-400
  { tag: [t.separator, t.brace, t.squareBracket, t.punctuation], color: '#71717a' }, // zinc-500
  { tag: t.invalid, color: '#fb7185' }, // rose-400
])

const theme = EditorView.theme(
  {
    '&': { height: '100%', backgroundColor: '#000', color: '#e4e4e7' },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': {
      fontFamily: 'var(--font-mono)',
      fontSize: '13px',
      lineHeight: '1.6',
      overflow: 'auto',
    },
    '.cm-content': { padding: '16px 0', caretColor: '#34d399' },
    '.cm-gutters': {
      backgroundColor: '#000',
      color: '#3f3f46', // zinc-700
      border: 'none',
      paddingLeft: '8px',
    },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: '#a1a1aa' }, // zinc-400
    '.cm-activeLine': { backgroundColor: '#ffffff06' },
    '.cm-cursor': { borderLeftColor: '#34d399' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: '#34d39926',
    },
    '.cm-selectionMatch': { backgroundColor: '#34d39918' },
    '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
      backgroundColor: '#34d39926',
      outline: 'none',
      color: 'inherit',
    },
    '.cm-nonmatchingBracket': { color: '#fb7185' },
    '.cm-foldPlaceholder': {
      backgroundColor: '#18181b',
      border: '1px solid #27272a',
      color: '#71717a',
      padding: '0 4px',
    },
    '.cm-lint-marker': { width: '0.8em', height: '0.8em' },
    '.cm-tooltip': {
      backgroundColor: '#18181b',
      border: '1px solid #27272a',
      borderRadius: '6px',
      color: '#e4e4e7',
      fontFamily: 'var(--font-mono)',
      fontSize: '12px',
    },
    '.cm-tooltip .cm-tooltip-arrow:after': { borderTopColor: '#18181b' },
    '.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--font-mono)', maxHeight: '16em' },
    '.cm-tooltip-autocomplete > ul > li': { padding: '3px 8px', lineHeight: '1.5' },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
      backgroundColor: '#34d3991f',
      color: '#e4e4e7',
    },
    '.cm-completionMatchedText': { textDecoration: 'none', color: '#34d399', fontWeight: '600' },
    '.cm-completionDetail': { color: '#52525b', fontStyle: 'normal', marginLeft: '1.5em' },
    // Active snippet tab-stop.
    '.cm-snippetField': { backgroundColor: '#34d39926', outline: '1px solid #34d39940' },
    '.cm-panels': {
      backgroundColor: '#09090b',
      color: '#e4e4e7',
      borderTop: '1px solid #27272a',
      fontFamily: 'var(--font-mono)',
      fontSize: '12px',
    },
    '.cm-panel input, .cm-panel button': { backgroundColor: '#18181b', color: '#e4e4e7' },
  },
  { dark: true },
)

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
          theme,
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

  // Adopt external edits (e.g. the store reformatting the draft). Keystrokes
  // round-trip to the same string, so this is a no-op while typing.
  useEffect(() => {
    const instance = view.current
    if (!instance || value === instance.state.doc.toString()) return
    instance.dispatch({
      changes: { from: 0, to: instance.state.doc.length, insert: value },
    })
  }, [value])

  return <div ref={host} className="min-h-0 w-full flex-1 overflow-hidden bg-black" />
}

export default JsonEditor
