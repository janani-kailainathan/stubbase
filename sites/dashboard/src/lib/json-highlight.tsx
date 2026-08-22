import type { ReactNode } from 'react'

const TOKEN_RE =
  /("(?:\\u[0-9a-fA-F]{4}|\\[^u]|[^\\"])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([{}[\],])/g

/**
 * Syntax-highlights JSON (re-formatted to 2-space indent); non-JSON content
 * (TS models, .env) falls through and still gets string/number coloring,
 * matching the mock's behavior.
 */
export function JsonHighlight({ raw }: { raw: string }) {
  let text: string
  try {
    text = JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    text = raw
  }

  const nodes: ReactNode[] = []
  let last = 0
  let key = 0
  for (const m of text.matchAll(TOKEN_RE)) {
    const [full, str, colon, boolNull, num, punct] = m
    if (m.index > last) nodes.push(text.slice(last, m.index))
    if (str) {
      nodes.push(
        <span key={key++} className={colon ? 'text-emerald-400' : 'text-sky-300'}>
          {str}
        </span>,
        colon ?? '',
      )
    } else if (boolNull) {
      nodes.push(
        <span key={key++} className="text-purple-400">
          {boolNull}
        </span>,
      )
    } else if (num) {
      nodes.push(
        <span key={key++} className="text-amber-300">
          {num}
        </span>,
      )
    } else if (punct) {
      nodes.push(
        <span key={key++} className="text-zinc-500">
          {punct}
        </span>,
      )
    } else {
      nodes.push(full)
    }
    last = m.index + full.length
  }
  nodes.push(text.slice(last))

  return <pre className="font-mono text-[13px] leading-relaxed whitespace-pre-wrap">{nodes}</pre>
}
