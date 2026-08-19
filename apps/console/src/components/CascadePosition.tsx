// The one control for choosing where a source sits in the cascade: a native
// <select> over positions 1..N (+1 when placing a new source), each option
// naming the source it lands below. Shared by the Sources edit drawer and the
// add-a-source wizard so both speak in positions, never in the manifest's
// level integer — see cascade-order.ts for why the number stays hidden.
import { useEffect } from 'react'
import { positionOptions } from '../cascade-order'
import { C, css } from '../theme'

export function CascadePosition({
  id, value, namesAbove, onChange, disabled = false, hint,
}: {
  id: string
  /** 1-based position; 1 wins. */
  value: number
  /**
   * The OTHER sources, in cascade order, without the one being placed. The
   * select offers one more slot than there are names here.
   */
  namesAbove: readonly string[]
  onChange: (position: number) => void
  disabled?: boolean
  /** Replaces the default one-line reminder under the control. */
  hint?: string
}) {
  const options = positionOptions(namesAbove)
  // A value the list cannot show (the cascade shrank under an open form)
  // would leave the select rendering blank; clamp so it always names a slot —
  // and write the clamp back, so what is saved is what the select showed,
  // never a position no option ever offered.
  const shown = Math.min(Math.max(1, value), options.length)
  useEffect(() => {
    if (shown !== value) onChange(shown)
  }, [shown, value, onChange])
  return (
    <div>
      <label htmlFor={id} style={css(`display:block; font-size:12px; font-weight:600; color:${C.body}; margin-bottom:5px;`)}>Position in cascade</label>
      <select
        id={id}
        className="cc-position-select"
        value={shown}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      >
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
      <p style={css(`margin:5px 0 0; font-size:11.5px; line-height:1.5; color:${C.caption};`)}>
        {hint ?? 'Position 1 wins wherever it speaks; everything else is inherited from the layers below.'}
      </p>
    </div>
  )
}
