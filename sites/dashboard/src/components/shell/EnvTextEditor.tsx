import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'
import { CodeEditor } from './CodeEditor'

/**
 * The .env grammar, line by line, as lib/env.ts parses it: a line starting with
 * `#` is a comment; otherwise an optional `export`, a KEY, `=`, and the value.
 * Anything else is a line Save will refuse, and is marked as such while typing.
 */
const envLanguage = StreamLanguage.define<{ inValue: boolean }>({
  name: 'env',
  startState: () => ({ inValue: false }),
  token(stream, state) {
    if (stream.sol()) {
      state.inValue = false
      if (stream.eatSpace()) return null
    }
    if (!state.inValue) {
      if (stream.peek() === '#') {
        stream.skipToEnd()
        return 'comment'
      }
      if (stream.match(/^export\s+/)) return 'keyword'
      if (stream.match(/^[A-Za-z_][A-Za-z0-9_]*(?=\s*=)/)) return 'propertyName'
      if (stream.match(/^\s*=\s*/)) {
        state.inValue = true
        return 'operator'
      }
      stream.skipToEnd()
      return 'invalid'
    }
    if (stream.match(/^\d+/)) return 'number'
    while (!stream.eol() && !/\d/.test(stream.peek()!)) stream.next()
    return 'string'
  },
  // What Mod-/ (toggleComment, in the default keymap) puts in front of a line.
  languageData: { commentTokens: { line: '#' } },
})

/**
 * The saved view's colours (EnvHighlight in EnvEditor.tsx), token for token, so
 * starting to edit does not change what a commented line looks like.
 */
const envHighlight = HighlightStyle.define([
  { tag: t.comment, color: 'var(--faint)' },
  { tag: t.propertyName, color: 'var(--heading)' },
  { tag: [t.operator, t.keyword], color: 'var(--subtle)' },
  { tag: t.string, color: 'var(--body)' },
  { tag: t.number, color: 'var(--syntax-num)' },
  { tag: t.invalid, color: 'var(--syntax-invalid)' },
])

// Wrapped like the saved view, which is `whitespace-pre-wrap`.
const ENV_EXTENSIONS = [envLanguage, syntaxHighlighting(envHighlight), EditorView.lineWrapping]

/**
 * Editing the .env with the saved view's highlighting: comments dim, keys
 * bright, so what is switched on stays visible while typing. Mod-/ comments or
 * uncomments the lines under the cursor.
 *
 * Loaded lazily (see EnvView) — CodeMirror stays out of the initial bundle.
 */
export default function EnvTextEditor({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return <CodeEditor value={value} onChange={onChange} extensions={ENV_EXTENSIONS} />
}
