import type { Observation } from './Diagnostics'

export function activityBuckets(rows: Observation[], from: number, to: number) {
  const bins = Array.from({ length: 12 }, () => ({
    search: 0,
    read: 0,
    errors: 0,
  }))
  const span = Math.max(1, to - from)
  for (const row of rows) {
    if (
      !['search', 'read'].includes(row.operation) ||
      row.at < from ||
      row.at > to
    )
      continue
    const bin = bins[Math.min(11, Math.floor(((row.at - from) / span) * 12))]
    bin[row.operation as 'search' | 'read']++
    if (row.outcome === 'error') bin.errors++
  }
  return bins
}

export function DiagnosticActivity({
  rows,
  from,
  to,
}: {
  rows: Observation[]
  from: number
  to: number
}) {
  const bins = activityBuckets(rows, from, to)
  const count = bins.reduce((n, b) => n + b.search + b.read, 0)
  const available = from > 0 && to >= from
  const max = Math.max(1, ...bins.flatMap((b) => [b.search, b.read]))
  const time = (at: number) =>
    new Date(at).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  return (
    <section
      className="cc-diag-activity cc-diag-panel"
      aria-label="Retrieval activity"
    >
      <header className="cc-diag-section-heading">
        <h3>Retrieval activity</h3>
        <span className="cc-diag-note">
          {available ? `${count} observed` : 'Awaiting observations'}
        </span>
      </header>
      <p className="cc-diag-note">
        Search and read volume across this observation window.
      </p>
      {available && count > 0 ? (
        <>
          <svg
            viewBox="0 0 520 140"
            role="img"
            aria-label={`${count} retrieval observations from ${time(from)} to ${time(to)}. Bars show counts in 12 equal time intervals; dots mark failed operations.`}
          >
            {[0, 1].map((level) => (
              <g key={level}>
                <line
                  x1="28"
                  x2="512"
                  y1={108 - level * 80}
                  y2={108 - level * 80}
                  className="cc-diag-chart-grid"
                />
                <text x="20" y={112 - level * 80} textAnchor="end">
                  {level * max}
                </text>
              </g>
            ))}
            {bins.map((b, i) => {
              const x = 34 + i * 40
              return (
                <g key={i}>
                  <title>
                    {time(from + ((to - from) * i) / 12)}: {b.search} searches,{' '}
                    {b.read} reads, {b.errors} failures
                  </title>
                  {b.search > 0 && (
                    <rect
                      x={x}
                      y={108 - (b.search / max) * 80}
                      width="12"
                      height={(b.search / max) * 80}
                      rx="1"
                      className="cc-diag-series-search"
                    />
                  )}
                  {b.read > 0 && (
                    <rect
                      x={x + 14}
                      y={108 - (b.read / max) * 80}
                      width="12"
                      height={(b.read / max) * 80}
                      rx="1"
                      className="cc-diag-series-read"
                    />
                  )}
                  {b.errors > 0 && (
                    <circle
                      cx={x + 13}
                      cy="16"
                      r="3"
                      className="cc-diag-series-error"
                    />
                  )}
                </g>
              )
            })}
            <text x="28" y="132">
              {time(from)}
            </text>
            <text x="270" y="132" textAnchor="middle">
              {time((from + to) / 2)}
            </text>
            <text x="512" y="132" textAnchor="end">
              {time(to)}
            </text>
          </svg>
          <div className="cc-diag-legend">
            <span>
              <i className="cc-diag-series-search" />
              Search
            </span>
            <span>
              <i className="cc-diag-series-read" />
              Read context
            </span>
            <span>
              <i className="cc-diag-series-error" />
              Failure
            </span>
          </div>
          <details className="cc-diag-intervals">
            <summary>View interval counts</summary>
            <div className="cc-diag-table">
              <table>
                <caption className="sr-only">
                  Observed retrievals by time interval
                </caption>
                <thead>
                  <tr>
                    <th>Interval</th>
                    <th className="is-number">Search</th>
                    <th className="is-number">Read</th>
                    <th className="is-number">Failed</th>
                  </tr>
                </thead>
                <tbody>
                  {bins.map((bin, i) => (
                    <tr key={i}>
                      <th scope="row">
                        {time(from + ((to - from) * i) / 12)}–
                        {time(from + ((to - from) * (i + 1)) / 12)}
                      </th>
                      <td className="is-number">{bin.search}</td>
                      <td className="is-number">{bin.read}</td>
                      <td className="is-number">{bin.errors}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      ) : (
        <div className="cc-diag-chart-empty">
          <strong>
            {available ? 'No retrieval activity yet' : 'Waiting for the engine'}
          </strong>
          <span>
            {available
              ? 'Search your project context to start measuring traffic.'
              : 'Activity will appear when diagnostic observations are available.'}
          </span>
        </div>
      )}
    </section>
  )
}
