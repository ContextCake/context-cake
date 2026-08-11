import { ShortcutLabel } from './ui'

type Shortcut = { keys: string; label: string; note?: string }
type ShortcutGroup = { title: string; note?: string; items: Shortcut[] }

// One list, three binding sites: the console's own keyboard handlers (App.tsx
// — navigation, palette, search, Ask, and the Review queue's S/R/D routing —
// plus the Files editor's ⌘S in views/Files.tsx) and the Mac app's menu
// accelerators (apps/desktop/src/main/menu.mjs), which carry the same chords.
// A chord change at any of those sites has to land here too.
const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: 'Navigate',
    items: [
      { keys: '⌘1', label: 'Go to Home' },
      { keys: '⌘2', label: 'Go to Cascade' },
      { keys: '⌘3', label: 'Go to Knowledge' },
      { keys: '⌘4', label: 'Go to Sources' },
      { keys: '⌘5', label: 'Go to Review' },
      { keys: '⇧⌘F', label: 'Go to Knowledge: Files' },
    ],
  },
  {
    title: 'Tools',
    items: [
      { keys: '⌘K', label: 'Open the command palette' },
      { keys: '⌘F', label: 'Search this view' },
      { keys: '⇧⌘A', label: 'Ask ContextCake' },
      { keys: '⌘,', label: 'Open Settings' },
      { keys: 'Esc', label: 'Close dialogs and panels' },
    ],
  },
  {
    title: 'Review queue',
    note: 'With a signal selected in Review.',
    items: [
      { keys: 'S', label: 'Store to shared context' },
      { keys: 'R', label: 'Keep in review' },
      { keys: 'D', label: 'Discard' },
    ],
  },
  {
    title: 'Files',
    items: [
      { keys: '⌘S', label: 'Save the open file', note: 'In the Files editor, when the file is editable.' },
    ],
  },
]

export function ShortcutsReference() {
  return (
    <section className="cc-settings-section" aria-labelledby="cc-settings-shortcuts">
      <h2 id="cc-settings-shortcuts">Keyboard shortcuts</h2>
      {SHORTCUT_GROUPS.map((group) => (
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
