import { css, lc, MONO } from '../theme'
import { layerName } from '../data'
import type { LayerId } from '../theme'

export function LayerChip({ id }: { id: LayerId }) {
  const c = lc(id)
  return (
    <span style={css(`display:inline-flex; align-items:center; font-family:${MONO}; font-size:9.5px; font-weight:600; letter-spacing:0.06em; text-transform:uppercase; padding:2px 7px; border-radius:999px; background:${c.fill}; color:${c.text}; border:1px solid ${c.strokeE};`)}>
      {layerName(id)}
    </span>
  )
}
