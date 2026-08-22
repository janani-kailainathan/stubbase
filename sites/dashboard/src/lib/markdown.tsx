/**
 * A deliberately small markdown renderer for Co-Pilot replies.
 *
 * The persona tells the model to use markdown for code formatting, so its
 * answers arrive with fences, `inline code` and bullet lists. That is the whole
 * subset worth supporting — pulling in a full markdown library (and a sanitizer
 * to go with it) to render four constructs would be a poor trade on a page that
 * already ships CodeMirror.
 *
 * Everything is built as React elements from parsed text. Nothing here ever
 * touches dangerouslySetInnerHTML, so model output cannot inject markup.
 */
import type { ReactNode } from 'react'

/** ``` fences, capturing an optional language tag. */
const FENCE = /```([\w-]*)\n?([\s\S]*?)```/g
/** `code`, **bold**, *italic* — first match wins, left to right. */
const INLINE = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*/g

const BULLET = /^\s*[-*+]\s+(.*)$/
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/
const HEADING = /^#{1,6}\s+(.*)$/

function inline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let match: RegExpExecArray | null
  INLINE.lastIndex = 0

  while ((match = INLINE.exec(text)) !== null) {
    if (match.index > last) out.push(text.slice(last, match.index))
    const key = `${keyPrefix}-${match.index}`
    if (match[1] !== undefined) {
      out.push(
        <code key={key} className="rounded bg-zinc-950 px-1 py-0.5 text-emerald-300">
          {match[1]}
        </code>,
      )
    } else if (match[2] !== undefined) {
      out.push(
        <strong key={key} className="font-semibold text-zinc-100">
          {match[2]}
        </strong>,
      )
    } else {
      out.push(
        <em key={key} className="text-zinc-300 italic">
          {match[3]}
        </em>,
      )
    }
    last = match.index + match[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  return (
    <div className="overflow-hidden rounded-md border border-zinc-800 bg-zinc-950">
      {lang && (
        <div className="border-b border-zinc-800 px-2.5 py-1 font-mono text-[10px] text-zinc-600">
          {lang}
        </div>
      )}
      {/* Long lines scroll inside the block; the chat column must not. */}
      <pre className="overflow-x-auto p-2.5 font-mono text-[11px] leading-relaxed text-zinc-200">
        {code.replace(/\n$/, '')}
      </pre>
    </div>
  )
}

/** Prose between fences: headings, bullet/numbered lists, paragraphs. */
function prose(text: string, keyPrefix: string): ReactNode[] {
  const blocks: ReactNode[] = []
  const lines = text.split('\n')
  let paragraph: string[] = []
  let list: { ordered: boolean; items: string[] } | null = null

  const flushParagraph = () => {
    if (paragraph.length === 0) return
    const key = `${keyPrefix}-p${blocks.length}`
    blocks.push(<p key={key}>{inline(paragraph.join(' '), key)}</p>)
    paragraph = []
  }
  const flushList = () => {
    if (!list) return
    const key = `${keyPrefix}-l${blocks.length}`
    const items = list.items.map((item, i) => (
      <li key={`${key}-${i}`} className="ml-4 list-outside">
        {inline(item, `${key}-${i}`)}
      </li>
    ))
    blocks.push(
      list.ordered ? (
        <ol key={key} className="list-decimal space-y-1">
          {items}
        </ol>
      ) : (
        <ul key={key} className="list-disc space-y-1">
          {items}
        </ul>
      ),
    )
    list = null
  }

  for (const line of lines) {
    if (!line.trim()) {
      flushParagraph()
      flushList()
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      flushParagraph()
      flushList()
      const key = `${keyPrefix}-h${blocks.length}`
      blocks.push(
        <p key={key} className="font-semibold text-zinc-100">
          {inline(heading[1], key)}
        </p>,
      )
      continue
    }

    const bullet = BULLET.exec(line)
    const numbered = bullet ? null : NUMBERED.exec(line)
    if (bullet || numbered) {
      flushParagraph()
      const ordered = Boolean(numbered)
      if (!list || list.ordered !== ordered) {
        flushList()
        list = { ordered, items: [] }
      }
      list.items.push((bullet ?? numbered)![1])
      continue
    }

    flushList()
    paragraph.push(line.trim())
  }
  flushParagraph()
  flushList()
  return blocks
}

export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = []
  let last = 0
  let match: RegExpExecArray | null
  FENCE.lastIndex = 0

  while ((match = FENCE.exec(text)) !== null) {
    if (match.index > last) blocks.push(...prose(text.slice(last, match.index), `b${last}`))
    blocks.push(<CodeBlock key={`c${match.index}`} code={match[2]} lang={match[1]} />)
    last = match.index + match[0].length
  }
  // An unterminated fence (a reply cut off mid-block) still renders as prose.
  if (last < text.length) blocks.push(...prose(text.slice(last), `b${last}`))

  return <div className="space-y-2">{blocks}</div>
}
