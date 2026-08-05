import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement> & { size?: 16 | 20 }

function Icon({ size = 16, children, ...props }: IconProps) {
  return <svg {...props} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
}

export const HomeIcon = (props: IconProps) => <Icon {...props}><path d="m4 10 8-6 8 6v9a1 1 0 0 1-1 1h-5v-6h-4v6H5a1 1 0 0 1-1-1z" /></Icon>
export const CascadeIcon = (props: IconProps) => <Icon {...props}><rect x="3" y="3" width="7" height="6" rx="1.5" /><rect x="14" y="9" width="7" height="6" rx="1.5" /><rect x="3" y="15" width="7" height="6" rx="1.5" /><path d="M10 6h2a3 3 0 0 1 3 3M10 18h2a3 3 0 0 0 3-3" /></Icon>
export const KnowledgeIcon = (props: IconProps) => <Icon {...props}><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H12v17H6.5A2.5 2.5 0 0 0 4 22z" /><path d="M20 5.5A2.5 2.5 0 0 0 17.5 3H12v17h5.5A2.5 2.5 0 0 1 20 22z" /></Icon>
export const SourcesIcon = (props: IconProps) => <Icon {...props}><ellipse cx="12" cy="5.5" rx="7" ry="2.5" /><path d="M5 5.5v6c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-6M5 11.5v6c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-6" /></Icon>
export const ReviewIcon = (props: IconProps) => <Icon {...props}><path d="M5 4h14v16H5zM8 8h8M8 12h8M8 16h5" /></Icon>
export const SettingsIcon = (props: IconProps) => <Icon {...props}><circle cx="12" cy="12" r="3" /><path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.4-2.4 1A7 7 0 0 0 15 6l-.4-2.6h-4L10 6a7 7 0 0 0-1.5 1.1l-2.4-1-2 3.4 2 1.5a7 7 0 0 0 0 2l-2 1.5 2 3.4 2.4-1A7 7 0 0 0 10 18l.5 2.6h4L15 18a7 7 0 0 0 1.5-1.1l2.4 1 2-3.4-2-1.5a7 7 0 0 0 .1-1z" /></Icon>
export const SidebarIcon = (props: IconProps) => <Icon {...props}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></Icon>
export const SearchIcon = (props: IconProps) => <Icon {...props}><circle cx="10.5" cy="10.5" r="6" /><path d="m15 15 4.5 4.5" /></Icon>
export const SparkleIcon = (props: IconProps) => <Icon {...props}><path d="m12 3 1.8 4.8 4.8 1.8-4.8 1.8-1.8 4.8-1.8-4.8-4.8-1.8 4.8-1.8zM18.5 16l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" /></Icon>
export const PlusIcon = (props: IconProps) => <Icon {...props}><path d="M12 5v14M5 12h14" /></Icon>
export const AgentIcon = (props: IconProps) => <Icon {...props}><rect x="3" y="5" width="18" height="14" rx="3" /><path d="M8 12h8M12 8v8" /></Icon>
export const CloseIcon = (props: IconProps) => <Icon {...props}><path d="m6 6 12 12M18 6 6 18" /></Icon>
