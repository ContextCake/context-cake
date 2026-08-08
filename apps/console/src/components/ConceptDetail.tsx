import { useMemo } from 'react'
import { C, css, lc, MONO, conceptTypeStyle } from '../theme'
import type { Concept } from '../data'
import { filesRevalidation, useLayerFiles } from '../layer-files'
import { useStoreData } from '../store'
import { LayerChip } from './LayerChip'

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
      className="cc-h-bd-strong"
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
export function ConceptDetail({ concept }: { concept: Concept }) {
  const fileByContributor = useFileByContributor()
  const fileFor = (sourceLayer: string) => fileByContributor.get(contributorKey(sourceLayer, concept.id))
  return (
    <>
      <div style={css('display:flex; align-items:center; gap:10px;')}>
        <span style={conceptTypeStyle(concept.type)}>{concept.type}</span>
        <code style={css(`font-family:${MONO}; font-size:12px; color:#57564F;`)}>{concept.id}</code>
      </div>
      <h2 style={css('margin:13px 0 12px; font-size:22px; font-weight:600; letter-spacing:-0.01em;')}>{concept.title}</h2>
      <div style={css('display:flex; align-items:center; gap:10px; padding-bottom:18px; margin-bottom:4px; border-bottom:1px solid #E4E1D6;')}>
        <span style={css('font-size:11px; font-weight:600; letter-spacing:0.05em; text-transform:uppercase; color:#8A8A82;')}>Resolved from</span>
        <div style={css('display:flex; gap:5px;')}>
          {concept.layers.map((l) => <LayerChip key={l} id={l} />)}
        </div>
        <span style={css(`margin-left:auto; font-size:11.5px; color:#57564F; font-family:${MONO};`)}>{concept.sections.length} sections</span>
      </div>

      <div style={css('display:flex; flex-direction:column;')}>
        {concept.sections.length === 0 && <EmptyConcept concept={concept} fileFor={fileFor} />}
        {concept.sections.map((s) => {
          const col = lc(s.winner)
          const dissents = s.dissents ?? []
          // The real source that won this section, not the three-lane bucket it
          // renders in — two sources can share a lane, and only the source name
          // says which one is behind the value. The colored dot beside the
          // heading already carries the lane; this text carries provenance.
          const provenance = `${s.sourceLayer}${s.updated ? ' · ' + s.updated : ''}`
          return (
            <div key={s.key ?? s.name} style={css('padding:16px 0; border-bottom:1px solid #EDEAE0;')}>
              <div style={css('display:flex; align-items:center; gap:9px; margin-bottom:8px;')}>
                <span aria-hidden="true" style={css(`flex:0 0 auto; width:10px; height:10px; border-radius:3px; background:${col.strokeE};`)} />
                <h3 style={css('margin:0; font-size:14px; font-weight:600;')}>{s.name}</h3>
                <span style={css(`margin-left:auto; flex:0 0 auto; font-family:${MONO}; font-size:10.5px; color:${col.text2};`)}>{provenance}</span>
                <OpenFile layer={s.sourceLayer} path={fileFor(s.sourceLayer)} conceptId={concept.id} />
              </div>

              {s.suppressed ? (
                <div style={css('display:flex; align-items:center; gap:7px; font-size:12px; color:#8A8A82;')}>
                  <span aria-hidden="true">▢</span>
                  <span>suppressed by {s.sourceLayer}</span>
                </div>
              ) : (
                <div style={css('font-size:13.5px; color:#1A1915; line-height:1.55;')}>{s.value}</div>
              )}

              {dissents.length > 0 && (
                <div style={css('display:flex; flex-direction:column; gap:6px; margin-top:10px;')}>
                  {dissents.map((d, i) => {
                    const dc = lc(d.layer)
                    return (
                      <div key={`${d.layer}-${i}`} style={css('display:flex; align-items:flex-start; gap:9px; padding:10px 12px; background:#FBF0DD; border:1px solid #E8C88C; border-radius:9px;')}>
                        <svg style={{ flex: '0 0 auto', marginTop: 1 }} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#C77D2A" strokeWidth="2.2" strokeLinecap="round"><path d="M12 8v5M12 16.5v.5" /><circle cx="12" cy="12" r="9" /></svg>
                        <div style={css('flex:1; font-size:12px; color:#5A3D12; line-height:1.45;')}>
                          <span style={css(`display:inline-flex; align-items:center; font-family:${MONO}; font-size:9px; font-weight:600; letter-spacing:0.05em; text-transform:uppercase; padding:1px 6px; border-radius:999px; background:#FFFFFF; color:${dc.text}; border:1px solid ${dc.strokeE}; margin-right:2px;`)}>{d.sourceLayer}</span> says <span style={{ color: 'var(--cc-amber-text2)' }}>"{d.value}"</span> — overridden here.
                        </div>
                        {d.updated && <span style={css(`flex:0 0 auto; font-family:${MONO}; font-size:10px; color:${C.amberText2};`)}>{d.updated}</span>}
                        <OpenFile layer={d.sourceLayer} path={fileFor(d.sourceLayer)} conceptId={concept.id} />
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </>
  )
}
