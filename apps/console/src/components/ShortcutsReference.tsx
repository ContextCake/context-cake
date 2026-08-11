import type { Mode } from '../api'
import { ShortcutLabel } from './ui'

type Shortcut = { keys: string; label: string; note?: string }
type ShortcutGroup = { title: string; note?: string; items: Shortcut[] }

// Every binding is CmdOrCtrl (App.tsx tests `e.metaKey || e.ctrlKey`;
// menu.mjs uses `CmdOrCtrl+`), so the glyph is the platform's, not a hardcoded
// ⌘. The console ships as a public Web Demo too, where a Windows visitor has
// no Command key — printing ⌘ there documents a chord they cannot press.
const APPLE = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent)
const MOD = APPLE ? '⌘' : 'Ctrl+'
const SHIFT_MOD = APPLE ? '⇧⌘' : 'Ctrl+Shift+'

// One list, three binding sites: the console's own keyboard handlers (App.tsx
// — navigation, palette, search, Ask, and the Review queue's S/R/D routing —
// plus the Files editor's save chord in views/Files.tsx) and the Mac app's
// menu accelerators (apps/desktop/src/main/menu.mjs), which carry the same
// chords. A chord change at any of those sites has to land here too.
function groupsFor(appMode: Mode): ShortcutGroup[] {
  const groups: ShortcutGroup[] = [
    {
      title: 'Navigate',
      items: [
        { keys: `${MOD}1`, label: 'Go to Home' },
        { keys: `${MOD}2`, label: 'Go to Cascade' },
        { keys: `${MOD}3`, label: 'Go to Knowledge' },
        { keys: `${MOD}4`, label: 'Go to Sources' },
        { keys: `${MOD}5`, label: 'Go to Review' },
        { keys: `${SHIFT_MOD}F`, label: 'Go to Knowledge: Files' },
      ],
    },
    {
      title: 'Tools',
      items: [
        { keys: `${MOD}K`, label: 'Open the command palette' },
        { keys: `${MOD}F`, label: 'Search this view', note: 'In Concepts, Files, Sources, Review and Conflicts. Elsewhere your browser’s own Find opens instead.' },
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
      title: 'Review queue',
      note: 'In Review → Queue, with a signal selected.',
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
