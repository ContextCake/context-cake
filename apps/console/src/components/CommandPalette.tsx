import { useEffect, useMemo, useRef, useState } from 'react'
import { SearchIcon } from './icons'
import { ShortcutLabel } from './ui'

export type PaletteCommand = {
  id: string
  label: string
  keywords?: string
  shortcut?: string
  run: () => void
}

export function CommandPalette({ commands, onClose }: { commands: readonly PaletteCommand[]; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const dialog = useRef<HTMLDivElement>(null)
  const results = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (!words.length) return commands
    return commands.filter((command) => {
      const haystack = `${command.label} ${command.keywords ?? ''}`.toLowerCase()
      return words.every((word) => haystack.includes(word))
    })
  }, [commands, query])

  useEffect(() => { input.current?.focus() }, [])
  useEffect(() => { setSelected(0) }, [query])

  const execute = (index: number) => {
    const command = results[index]
    if (!command) return
    onClose()
    command.run()
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); onClose(); return }
    if (event.key === 'ArrowDown') { event.preventDefault(); setSelected((value) => results.length ? (value + 1) % results.length : 0); return }
    if (event.key === 'ArrowUp') { event.preventDefault(); setSelected((value) => results.length ? (value - 1 + results.length) % results.length : 0); return }
    if (event.key === 'Enter') { event.preventDefault(); execute(selected); return }
    if (event.key === 'Tab') {
      const focusable = Array.from(dialog.current?.querySelectorAll<HTMLElement>('input,button,[tabindex]:not([tabindex="-1"])') ?? [])
      if (!focusable.length) return
      const position = focusable.indexOf(document.activeElement as HTMLElement)
      const next = event.shiftKey ? (position - 1 + focusable.length) % focusable.length : (position + 1) % focusable.length
      event.preventDefault()
      focusable[next]?.focus()
    }
  }

  return (
    <div className="cc-palette-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div ref={dialog} className="cc-command-palette" role="dialog" aria-modal="true" aria-label="Command palette" onKeyDown={onKeyDown}>
        <label className="cc-palette-search">
          <SearchIcon size={20} />
          <span className="sr-only">Search commands</span>
          <input ref={input} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search commands" autoComplete="off" />
          <ShortcutLabel>esc</ShortcutLabel>
        </label>
        <div className="cc-palette-count" aria-live="polite">{results.length} command{results.length === 1 ? '' : 's'}</div>
        <div className="cc-palette-results" role="listbox" aria-label="Commands">
          {results.map((command, index) => <button
            key={command.id} type="button" role="option" aria-selected={selected === index}
            onMouseEnter={() => setSelected(index)} onClick={() => execute(index)}
          >
            <span>{command.label}</span>{command.shortcut && <ShortcutLabel>{command.shortcut}</ShortcutLabel>}
          </button>)}
          {!results.length && <p className="cc-palette-empty">No matching commands</p>}
        </div>
      </div>
    </div>
  )
}
