// The evidence half of a discrepancy's detail: every source's answer with a
// word or line diff against the effective one, and the decision history.
// Pure presentation over a loaded `Conflict`; the panel that decides is
// DecisionPanel.tsx next door.
import type { Conflict, Contribution } from '../../data'
import { Markdown } from '../../components/Markdown'
import { formatDate } from './labels'

function valueKind(value: string) {
  return /```|^\s*[{[]|\n\s*[-+]?\s*["'][^\n]+:|\n.*[;{}]$/m.test(value) ? 'structured' : 'prose'
}

type DiffOperation = { type: 'same' | 'removed' | 'added'; value: string }

function sequenceDiff(left: string[], right: string[]): DiffOperation[] {
  // Bound quadratic work for unusually large answers. The fallback remains
  // honest and complete—it shows both originals as removed/added—without
  // letting a pathological document freeze the review surface.
  if (left.length * right.length > 120_000) {
    return [
      ...left.map((value) => ({ type: 'removed' as const, value })),
      ...right.map((value) => ({ type: 'added' as const, value })),
    ]
  }
  const width = right.length + 1
  const table = new Uint32Array((left.length + 1) * width)
  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      table[i * width + j] = left[i - 1] === right[j - 1]
        ? table[(i - 1) * width + j - 1] + 1
        : Math.max(table[(i - 1) * width + j], table[i * width + j - 1])
    }
  }
  const operations: DiffOperation[] = []
  let i = left.length
  let j = right.length
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && left[i - 1] === right[j - 1]) {
      operations.push({ type: 'same', value: left[i - 1] }); i -= 1; j -= 1
    } else if (j > 0 && (i === 0 || table[i * width + j - 1] >= table[(i - 1) * width + j])) {
      operations.push({ type: 'added', value: right[j - 1] }); j -= 1
    } else {
      operations.push({ type: 'removed', value: left[i - 1] }); i -= 1
    }
  }
  return operations.reverse()
}

function wordDiff(base: string, alternative: string) {
  return sequenceDiff(base.split(/(\s+)/), alternative.split(/(\s+)/)).map((operation, index) => (
    operation.type === 'removed' ? <del key={index}>{operation.value}</del>
      : operation.type === 'added' ? <mark key={index}>{operation.value}</mark>
        : <span key={index}>{operation.value}</span>
  ))
}

function lineDiff(base: string, alternative: string) {
  return sequenceDiff(base.split('\n'), alternative.split('\n')).map((operation, index) => (
    <div key={index} data-change={operation.type}>
      {operation.type !== 'same' && <span className="sr-only">{operation.type === 'removed' ? 'Removed: ' : 'Added: '}</span>}
      <span aria-hidden="true">{operation.type === 'removed' ? '- ' : operation.type === 'added' ? '+ ' : '  '}</span>{operation.value || ' '}
    </div>
  ))
}

export function Diff({ effective, value }: { effective: string; value: string }) {
  if (effective === value) return <p className="cc-diff-same">Matches the effective answer.</p>
  return valueKind(value) === 'structured'
    ? <pre className="cc-line-diff" aria-label="Line comparison">{lineDiff(effective, value)}</pre>
    : <p className="cc-word-diff" aria-label="Word comparison">{wordDiff(effective, value)}</p>
}

export function SourceAnswer({ choice, effective, isEffective }: { choice: Contribution; effective: string; isEffective: boolean }) {
  return (
    <article className="cc-discrepancy-answer" data-effective={isEffective || undefined}>
      <header>
        <strong>{choice.sourceLayer}</strong>
        <span>{isEffective ? 'Effective now' : choice.fresherDissent ? 'Newer dissent' : 'Alternative'}</span>
      </header>
      <div className="cc-discrepancy-meta">Updated {formatDate(choice.updated)}</div>
      {!isEffective && <Diff effective={effective} value={choice.value} />}
      <details>
        <summary>Inspect full original value</summary>
        <Markdown className="cc-discrepancy-original" source={choice.value} />
      </details>
    </article>
  )
}

const ACTION_LABEL: Record<string, string> = {
  acknowledge: 'Kept scoped difference', compose: 'Wrote reconciled answer', choose_contribution: 'Used an existing answer',
  rewrite_link: 'Rewrote the link', unlink: 'Removed the link', create_stub: 'Created the missing concept',
}

export function History({ conflict }: { conflict: Conflict }) {
  if (!conflict.history.length) return <p className="cc-muted">No previous decisions.</p>
  return (
    <ol className="cc-discrepancy-history">
      {[...conflict.history].reverse().map((record) => (
        <li key={record.id}>
          <div className="cc-history-head">
            <strong>{ACTION_LABEL[record.action ?? 'choose_contribution'] ?? 'Used an existing answer'}</strong>
            <span>{formatDate(record.decidedAt)}</span>
          </div>
          <p>{record.reason}</p>
          <div className="cc-history-facts">
            <span>Actor: {record.actor}</span>
            <span>Result: {record.transactionState ?? 'committed'}</span>
            {record.ruleId && <span>Rule: {record.ruleId}</span>}
            {record.supersedes && <span>Superseded: {record.supersedes}</span>}
          </div>
          {record.writtenTargets?.length ? (
            <details><summary>{record.writtenTargets.length} affected files</summary><ul>{record.writtenTargets.map((target) => <li key={`${record.id}-${target.path}`}><code>{target.path}</code></li>)}</ul></details>
          ) : null}
          <details>
            <summary>Original answers and decision evidence</summary>
            {(record.contributions ?? []).map((item) => <div className="cc-history-original" key={`${record.id}-${item.layer}`}><strong>{item.layer}</strong><pre>{item.content}</pre></div>)}
          </details>
        </li>
      ))}
    </ol>
  )
}

/** Placeholder lines while the full record is on its way — reserves the space, never a spinner over content. */
export function Skeleton({ lines = 3, label = 'Loading' }: { lines?: number; label?: string }) {
  return (
    <div className="cc-skeleton" role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">{label}…</span>
      {Array.from({ length: lines }, (_, index) => <span key={index} className="cc-skeleton-line" aria-hidden="true" />)}
    </div>
  )
}
