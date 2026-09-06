import { useEffect, useMemo, useRef, useState } from 'react'
import { C, css, lc, MONO, conceptTypeStyle } from '../theme'
import type { Concept } from '../data'
import { filesRevalidation, useLayerFiles } from '../layer-files'
import { useStoreData } from '../store'
import { Markdown } from './Markdown'

/** Which document extension wins when one concept id has several files behind it. */
const DOC_EXT = ['.md', '.markdown', '.mdx', '.txt']

/** JSON, not a joined string: a source name may contain spaces, and
 *  "a b" + "c" must never collide with "a" + "b c". */
const contributorKey = (layer: string, conceptId: string) => JSON.stringify([layer, conceptId])

/**
 * (source name, concept id) → the engine file path behind it.
 *
 * Built from the real `/api/files` listing rather than guessed as
 * `<id>.md`, so the link is only ever offered for a file that exists — a
 * `files`-kind layer may hold the concept as `.mdx` or `.txt`, and a
 * contributor read over MCP or the GitHub API keeps no file here at all and is
 * therefore absent from the listing. That absence is the gate: no entry, no
 * link, and so no affordance that opens on an error.
 */
function useFileByContributor(): Map<string, string> {
  const { mode, sources, reloadKey } = useStoreData()
  const { layers } = useLayerFiles(mode, filesRevalidation(sources, reloadKey))
  return useMemo(() => {
    const best = new Map<string, { path: string; rank: number }>()
    for (const entry of layers ?? []) {
      for (const file of entry.files) {
        const rank = DOC_EXT.indexOf(file.ext)
        if (rank === -1) continue
        const key = contributorKey(entry.layer, file.rel.slice(0, -file.ext.length))
        const current = best.get(key)
        if (!current || rank < current.rank) best.set(key, { path: file.path, rank })
      }
    }
    return new Map([...best].map(([key, value]) => [key, value.path]))
  }, [layers])
}

/** "Open file" for one contributor, or nothing when that layer keeps no file here. */
function OpenFile({ layer, path, conceptId }: { layer: string; path: string | undefined; conceptId: string }) {
  const { openFilesScope } = useStoreData()
  if (!path) return null
  return (
    <button
      type="button"
      className="cc-h-bd-strong cc-open-source"
      aria-label={`Open the ${layer} file behind ${conceptId}`}
      onClick={() => openFilesScope(layer, path)}
      style={css(`flex:0 0 auto; padding:2px 8px; border:1px solid ${C.line}; border-radius:999px; background:${C.raised}; cursor:pointer; font:inherit; font-size:10.5px; font-weight:600; color:${C.caption};`)}
    >Open file</button>
  )
}

/**
 * A concept with no sections is a dead end — the resolver produced an id and
 * some frontmatter, but nothing to read. Rather than rendering an empty
 * `<div>` with no explanation, name the situation and, where a source file is
 * identifiable, offer a way to it: the winning contributor's file, or —
 * absent a listing for it (an MCP or REST-read contributor keeps no file
 * here) — a plain way into the Files tab, scoped to that source, so browsing
 * is still one click away.
 */
function EmptyConcept({ concept, fileFor }: { concept: Concept; fileFor: (sourceLayer: string) => string | undefined }) {
  const { openFilesScope } = useStoreData()
  const winner = concept.contributorLayers?.[0]
  const path = winner ? fileFor(winner) : undefined
  return (
    <div style={css(`display:flex; flex-direction:column; gap:10px; align-items:flex-start; padding:16px 0;`)}>
      <p style={css('margin:0; font-size:13px; color:#57564F;')}>This concept has no sections — the file may be empty.</p>
      {winner && (
        path
          ? <OpenFile layer={winner} path={path} conceptId={concept.id} />
          : (
            <button
              type="button"
              className="cc-h-bd-strong"
              onClick={() => openFilesScope(winner)}
              style={css(`flex:0 0 auto; padding:5px 11px; border:1px solid ${C.line}; border-radius:999px; background:${C.raised}; cursor:pointer; font:inherit; font-size:11px; font-weight:600; color:${C.caption};`)}
            >Browse {winner} in Files</button>
          )
      )}
    </div>
  )
}

/** The resolved read of a concept — provenance chips per section + inline dissent.
 *  Shared by the Concepts view and the Canvas node slide-over. */
export function ConceptDetail({ concept, matchQuery = '' }: { concept: Concept; matchQuery?: string }) {
  const PAGE_SIZE = 20
  const [page, setPage] = useState(0)
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set())
  const lastMatch = useRef(-1)
  const reader = useRef<HTMLDivElement>(null)
  const pages = Math.max(1, Math.ceil(concept.sections.length / PAGE_SIZE))
  const currentPage = Math.min(page, pages - 1)
  const matches = useMemo(() => {
    const words = matchQuery.toLowerCase().split(/\s+/).filter(Boolean)
    return concept.sections.flatMap((section, index) => words.length && words.some((word) => `${section.name} ${section.value}`.toLowerCase().includes(word)) ? [index] : [])
  }, [concept.sections, matchQuery])
  useEffect(() => { lastMatch.current = -1 }, [concept.id, concept.sections, matchQuery])
  useEffect(() => { setPage(0); setCollapsed(new Set()) }, [concept.id])
  const jump = (index: number) => {
    lastMatch.current = index
    setPage(Math.floor(index / PAGE_SIZE))
    setCollapsed((prev) => { const next = new Set(prev); next.delete(index); return next })
    requestAnimationFrame(() => reader.current?.querySelector<HTMLButtonElement>(`[data-section="${index}"]`)?.focus())
  }
  const fileByContributor = useFileByContributor()
  const fileFor = (sourceLayer: string) => fileByContributor.get(contributorKey(sourceLayer, concept.id))
  return (
    <div ref={reader} className="cc-concept-reader">
      <div style={css('display:flex; align-items:center; gap:10px;')}>
        <span style={conceptTypeStyle(concept.type)}>{concept.type}</span>
        <code style={css(`font-family:${MONO}; font-size:12px; color:${C.caption};`)}>{concept.id}</code>
      </div>
      <h2 style={css('margin:13px 0 12px; font-size:26px; font-weight:600; letter-spacing:-0.01em;')}>{concept.title}</h2>
      <div className="cc-reader-origin"><span>Resolved from</span><strong>{(concept.contributorLayers ?? concept.layers).join(' · ')}</strong><span>{concept.sections.length} sections</span></div>
      {concept.sections.length > 1 && <nav className="cc-section-nav" aria-label="Document sections">
        <select aria-label="Jump to section" value="" onChange={(event) => jump(Number(event.target.value))}><option value="" disabled>Jump to section…</option>{concept.sections.map((section, index) => <option key={index} value={index}>{index + 1}. {section.name}</option>)}</select>
        {matches.length > 0 && <button type="button" onClick={() => jump(matches.find((index) => index > lastMatch.current) ?? matches[0])}>Jump to matching section ({matches.length})</button>}
        <button type="button" onClick={() => setCollapsed((prev) => prev.size ? new Set() : new Set(concept.sections.map((_, i) => i)))}>{collapsed.size ? 'Expand sections' : 'Collapse sections'}</button>
        {pages > 1 && <><button type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous sections</button><span role="status">{currentPage * PAGE_SIZE + 1}–{Math.min((currentPage + 1) * PAGE_SIZE, concept.sections.length)} of {concept.sections.length}</span><button type="button" disabled={currentPage === pages - 1} onClick={() => setPage(currentPage + 1)}>Next sections</button></>}
      </nav>}

      <div style={css('display:flex; flex-direction:column;')}>
        {concept.detailLoaded === false && (
          // A compact graph-first row: the document is being resolved right
          // now (store.loadConceptDetail follows the selection). Distinct from
          // EmptyConcept below — an empty answer must never look like a
          // loading one, and vice versa.
          <div role="status" style={css('padding:22px 0; font-size:13px; color:#8A8A82;')}>Resolving this concept…</div>
        )}
        {concept.detailLoaded !== false && concept.sections.length === 0 && <EmptyConcept concept={concept} fileFor={fileFor} />}
        {concept.detailLoaded !== false && concept.sections.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).map((s, offset) => {
          const index = currentPage * PAGE_SIZE + offset
          const col = lc(s.winner)
          const dissents = s.dissents ?? []
          // The real source that won this section, not the three-lane bucket it
          // renders in — two sources can share a lane, and only the source name
          // says which one is behind the value. The colored dot beside the
          // heading already carries the lane; this text carries provenance.
          const provenance = `${s.sourceLayer}${s.updated ? ' · ' + s.updated : ''}`
          return (
            <div key={s.key ?? s.name} style={css('padding:16px 0; border-bottom:1px solid #EDEAE0;')}>
              <div className="cc-section-heading-row">
                <span aria-hidden="true" style={css(`flex:0 0 auto; width:10px; height:10px; border-radius:3px; background:${col.strokeE};`)} />
                <h3><button type="button" data-section={index} aria-expanded={!collapsed.has(index)} onClick={() => setCollapsed((prev) => { const next = new Set(prev); if (next.has(index)) next.delete(index); else next.add(index); return next })}>{s.name}<span aria-hidden="true">{collapsed.has(index) ? ' +' : ' −'}</span></button></h3>
                <span className="cc-section-provenance">{provenance}</span>
                <OpenFile layer={s.sourceLayer} path={fileFor(s.sourceLayer)} conceptId={concept.id} />
              </div>

              {s.contextResolution && <p className="cc-context-resolution-note">{s.contextResolution.status === 'applied' ? `Source policy applied: ${s.contextResolution.selectedSource}. Original alternatives are preserved below.` : s.contextResolution.status === 'stale' ? 'The source policy is not currently applicable. This section is using the original cascade.' : 'Resolution undone. This section is using the original cascade.'}</p>}
              {!collapsed.has(index) && <>
              {s.suppressed ? (
                <div style={css('display:flex; align-items:center; gap:7px; font-size:12px; color:#8A8A82;')}>
                  <span aria-hidden="true">▢</span>
                  <span>suppressed by {s.sourceLayer}</span>
                </div>
              ) : (
                <Markdown source={s.value} className="cc-md" />
              )}

              {dissents.length > 0 && (
                <div style={css('display:flex; flex-direction:column; gap:6px; margin-top:10px;')}>
                  {dissents.map((d, i) => {
                    const dc = lc(d.layer)
                    return (
                      <div key={`${d.layer}-${i}`} className="cc-reader-dissent" style={css('display:flex; align-items:flex-start; gap:9px; padding:10px 12px; background:#FBF0DD; border:1px solid #E8C88C; border-radius:9px;')}>
                        <svg style={{ flex: '0 0 auto', marginTop: 1 }} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#C77D2A" strokeWidth="2.2" strokeLinecap="round"><path d="M12 8v5M12 16.5v.5" /><circle cx="12" cy="12" r="9" /></svg>
                        <div style={css('flex:1; font-size:12px; color:#5A3D12; line-height:1.45;')}>
                          <span style={css(`display:inline-flex; align-items:center; font-family:${MONO}; font-size:9px; font-weight:600; letter-spacing:0.05em; text-transform:uppercase; padding:1px 6px; border-radius:999px; background:#FFFFFF; color:${dc.text}; margin-right:2px;`)}>{d.sourceLayer}</span> · alternate value<Markdown source={d.value} className="cc-md" />
                        </div>
                        {d.updated && <span style={css(`flex:0 0 auto; font-family:${MONO}; font-size:10px; color:${C.amberText2};`)}>{d.updated}</span>}
                        <OpenFile layer={d.sourceLayer} path={fileFor(d.sourceLayer)} conceptId={concept.id} />
                      </div>
                    )
                  })}
                </div>
              )}
              </>}
            </div>
          )
        })}
      </div>
    </div>
  )
}
