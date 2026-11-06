import type { Mode } from '../api'
import { modKey, shiftModKey } from '../platform'
import { ShortcutLabel } from './ui'
import { NAVIGATION_SHORTCUTS, VIEW_TITLES } from '../shell-navigation'

type Shortcut = { keys: string; label: string; note?: string }
type ShortcutGroup = { title: string; note?: string; items: Shortcut[] }

// Digit bindings share the shell's navigation table. The cross-surface test
// checks that the native menu carries the same labels and accelerator keys.
function groupsFor(appMode: Mode): ShortcutGroup[] {
  // The platform's glyphs (platform.ts): ⌘ on a Mac, Ctrl+ on Linux and Windows.
  const MOD = modKey()
  const SHIFT_MOD = shiftModKey()
  const groups: ShortcutGroup[] = [
    {
      title: 'Navigate',
      items: [
        ...NAVIGATION_SHORTCUTS.map((item) => ({ keys: `${MOD}${item.key}`, label: `Go to ${item.label}` })),
        { keys: `${SHIFT_MOD}F`, label: `Go to ${VIEW_TITLES.files}` },
      ],
    },
    {
      title: 'Tools',
      items: [
        { keys: `${MOD}K`, label: 'Open the command palette' },
        { keys: `${MOD}F`, label: 'Search this view', note: 'In Library, Sources and Trust. Elsewhere your browser’s own Find opens instead.' },
        { keys: `${SHIFT_MOD}A`, label: 'Ask ContextCake' },
        { keys: `${MOD},`, label: 'Open Settings' },
        { keys: 'Esc', label: 'Close dialogs and panels' },
      ],
    },
    {
      title: 'Files',
      items: [
        { keys: `${MOD}S`, label: 'Save the open file', note: 'In the Files editor, when the file is editable.' },
      ],
    },
  ]

  // Routing a signal is demo-only (store.route() returns immediately unless
  // mode is 'demo', and live mode carries no signals at all), so listing S/R/D
  // in the Mac app would document three keys that can never fire.
  if (appMode === 'demo') {
    groups.splice(2, 0, {
      title: 'Trust: Captures',
      note: 'In Trust → Captures, with a signal selected.',
      items: [
        { keys: 'S', label: 'Store to shared context' },
        { keys: 'R', label: 'Keep in review' },
        { keys: 'D', label: 'Discard' },
      ],
    })
  }
  return groups
}

export function ShortcutsReference({ appMode }: { appMode: Mode }) {
  return (
    <section className="cc-settings-section" aria-labelledby="cc-settings-shortcuts">
      <h2 id="cc-settings-shortcuts">Keyboard shortcuts</h2>
      {groupsFor(appMode).map((group) => (
        <div key={group.title} className="cc-shortcut-group">
          <h3 className="cc-settings-subhead">{group.title}</h3>
          {group.note && <p className="cc-settings-hint" style={{ margin: '0 0 6px' }}>{group.note}</p>}
          <div className="cc-settings-group">
            {group.items.map((item) => (
              <div key={item.keys} className="cc-settings-row cc-settings-row--compact">
                <div>
                  <strong>{item.label}</strong>
                  {item.note && <span>{item.note}</span>}
                </div>
                <ShortcutLabel>{item.keys}</ShortcutLabel>
              </div>
            ))}
          </div>
        </div>
      ))}
    </section>
  )
}
