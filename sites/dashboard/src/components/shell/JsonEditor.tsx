import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from '@codemirror/autocomplete'
import { indentWithTab } from '@codemirror/commands'
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
import { Prec } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'
import { jsonRecordCompletions } from '@/lib/json-completion'
import { CodeEditor } from './CodeEditor'

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

/** Built once for every JSON editor: extensions are values, safe to share between views. */
const JSON_EXTENSIONS = [
  foldGutter(),
  lintGutter(),
  indentOnInput(),
  indentUnit.of('  '),
  bracketMatching(),
  closeBrackets(),
  json(),
  autocompletion({ override: [jsonRecordCompletions], icons: false }),
  linter(jsonParseLinter()),
  syntaxHighlighting(highlight),
  // Ahead of CodeEditor's default keymap, as it was when this file held the whole editor.
  Prec.high(keymap.of([...closeBracketsKeymap, ...completionKeymap, ...foldKeymap, ...lintKeymap, indentWithTab])),
]

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
  autoFocus = true,
}: {
  value: string
  onChange: (value: string) => void
  /** The file editor takes focus on Edit; the playground's body field must not steal it. */
  autoFocus?: boolean
}) {
  return <CodeEditor value={value} onChange={onChange} autoFocus={autoFocus} extensions={JSON_EXTENSIONS} />
}

export default JsonEditor
