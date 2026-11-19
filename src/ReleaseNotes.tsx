import { Fragment, useMemo } from 'react'
import { parseReleaseNotes } from './releaseNotesParser'
import type { ReleaseNoteInline, ReleasePageTarget } from './releaseNotesParser'

function renderInline(nodes: ReleaseNoteInline[], onOpenRelease?: (target: ReleasePageTarget) => void) {
  return nodes.map((node, index) => {
    if (node.type === 'text') return <Fragment key={index}>{node.text}</Fragment>
    if (node.type === 'code') return <code key={index}>{node.text}</code>
    if (node.type === 'strong') return <strong key={index}>{renderInline(node.children, onOpenRelease)}</strong>
    if (!onOpenRelease) return <Fragment key={index}>{node.label}</Fragment>
    return <button key={index} type="button" className="release-note-link" onClick={() => onOpenRelease(node.target)}>{node.label}</button>
  })
}

export default function ReleaseNotes({ notes, onOpenRelease }: {
  notes: string
  onOpenRelease?: (target: ReleasePageTarget) => void
}) {
  const blocks = useMemo(() => parseReleaseNotes(notes), [notes])
  if (!blocks.length) return null
  return <div className="update-notes">{blocks.map((block, index) => {
    if (block.type === 'heading') {
      const content = renderInline(block.children, onOpenRelease)
      return block.level === 3 ? <h4 key={index}>{content}</h4> : <h3 key={index}>{content}</h3>
    }
    if (block.type === 'list') {
      return <ul key={index}>{block.items.map((item, itemIndex) => <li key={itemIndex}>{renderInline(item, onOpenRelease)}</li>)}</ul>
    }
    return <p key={index}>{block.lines.map((line, lineIndex) => <Fragment key={lineIndex}>{lineIndex > 0 && <br />}{renderInline(line, onOpenRelease)}</Fragment>)}</p>
  })}</div>
}
