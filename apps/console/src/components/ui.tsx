import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react'

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'quiet' | 'danger'
}

export function Button({ variant = 'secondary', className = '', ...props }: ButtonProps) {
  return <button {...props} className={`cc-ui-button cc-ui-button--${variant} ${className}`.trim()} />
}

export function IconButton({ label, tooltip = label, className = '', ...props }: ButtonProps & { label: string; tooltip?: string }) {
  return <button {...props} aria-label={label} title={tooltip} className={`cc-ui-icon-button ${className}`.trim()} />
}

export function SegmentedControl<T extends string>({
  label, value, options, onChange,
}: {
  label: string
  value: T
  options: ReadonlyArray<{ value: T; label: string }>
  onChange: (value: T) => void
}) {
  return (
    <div className="cc-ui-segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function SearchField({ label = 'Search', className = '', ...props }: InputHTMLAttributes<HTMLInputElement> & { label?: string }) {
  return (
    <label className={`cc-ui-search ${className}`.trim()}>
      <span className="sr-only">{label}</span>
      <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.25" /><path d="m12.5 12.5 4 4" /></svg>
      <input type="search" {...props} />
    </label>
  )
}

export function StatusBadge({ tone = 'neutral', children }: { tone?: 'neutral' | 'success' | 'attention' | 'info'; children: ReactNode }) {
  return <span className={`cc-ui-status cc-ui-status--${tone}`}>{children}</span>
}

export function InlineNotice({ tone = 'info', children }: { tone?: 'info' | 'warning' | 'error'; children: ReactNode }) {
  return <div className={`cc-ui-notice cc-ui-notice--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>{children}</div>
}

export function ShortcutLabel({ children }: { children: ReactNode }) {
  return <kbd className="cc-ui-shortcut">{children}</kbd>
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return <div className="cc-ui-empty"><strong>{title}</strong>{children && <p>{children}</p>}{action}</div>
}
