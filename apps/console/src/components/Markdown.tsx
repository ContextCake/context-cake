// Renders parsed Markdown (src/markdown.ts) as React elements.
//
// Everything from the document arrives as a text node or an attribute React
// creates itself, so document content cannot become markup. There is no HTML
// string anywhere in this path and no `dangerouslySetInnerHTML` — a note that
// contains `<script>` renders as the characters `<script>`, by construction
// rather than by sanitizing.
import type { ReactNode } from 'react'
import { parseMarkdown, type Block, type Inline } from '../markdown'

function renderInline(nodes: Inline[], keyPrefix: string): ReactNode[] {
  return nodes.map((node, i) => {
    const key = `${keyPrefix}-${i}`
    switch (node.type) {
      case 'text':
        return node.value
      case 'code':
        return <code key={key}>{node.value}</code>
      case 'strong':
        return <strong key={key}>{renderInline(node.children, key)}</strong>
      case 'em':
        return <em key={key}>{renderInline(node.children, key)}</em>
      case 'del':
        return <del key={key}>{renderInline(node.children, key)}</del>
      case 'link':
        // The parser already dropped anything outside the navigational scheme
        // allowlist. rel=noopener so an opened tab never gets a window handle.
        return (
          <a key={key} href={node.href} target="_blank" rel="noopener noreferrer">
            {renderInline(node.children, key)}
          </a>
        )
      case 'image':
        return <img key={key} src={node.src} alt={node.alt} loading="lazy" />
      case 'wikilink':
        return <span key={key} className="cc-md-wikilink">{node.value}</span>
      default:
        return null
    }
  })
}

function renderBlock(block: Block, key: string): ReactNode {
  switch (block.type) {
    case 'heading': {
      const Tag = `h${block.level}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
      return <Tag key={key}>{renderInline(block.content, key)}</Tag>
    }
    case 'paragraph':
      return <p key={key}>{renderInline(block.content, key)}</p>
    case 'code':
      return (
        <pre key={key}>
          <code className={block.lang ? `language-${block.lang.replace(/[^\w.-]/g, '')}` : undefined}>
            {block.text}
          </code>
        </pre>
      )
    case 'list': {
      const items = block.items.map((item, i) => (
        <li key={`${key}-${i}`} className={item.task ? 'cc-md-task' : undefined}>
          {item.task && <input type="checkbox" checked={item.checked} disabled readOnly />}
          {item.task ? ' ' : null}
          {renderInline(item.content, `${key}-${i}`)}
        </li>
      ))
      return block.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>
    }
    case 'quote':
      return <blockquote key={key}>{renderInline(block.content, key)}</blockquote>
    case 'rule':
      return <hr key={key} />
    case 'table':
      return (
        // Wide tables scroll inside their own box — the page never scrolls sideways.
        <div key={key} className="cc-md-tablewrap">
          <table>
            <thead>
              <tr>{block.head.map((cell, i) => <th key={`${key}-h-${i}`}>{renderInline(cell, `${key}-h-${i}`)}</th>)}</tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={`${key}-r-${r}`}>
                  {row.map((cell, c) => <td key={`${key}-r-${r}-${c}`}>{renderInline(cell, `${key}-r-${r}-${c}`)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    default:
      return null
  }
}

export function Markdown({ source, className }: { source: string; className?: string }) {
  const blocks = parseMarkdown(source)
  return <div className={className}>{blocks.map((block, i) => renderBlock(block, `b${i}`))}</div>
}
