import { NavLink } from 'react-router-dom'
import LiveBar from './LiveBar.js'

const LINKS = [
  { to: '/', label: 'İdarə paneli' },
  { to: '/contexts', label: 'Kontekstlər' },
  { to: '/providers', label: 'Provayderlər' },
  { to: '/customizations', label: 'Fərdiləşdirmə' },
  { to: '/ladder', label: 'Nərdivan' },
  { to: '/workflows', label: 'Zəncirlər' },
  { to: '/history', label: 'Tarixçə' },
] as const

export default function Sidebar(): React.JSX.Element {
  return (
    <nav className="w-56 shrink-0 border-r border-white/10 bg-surface-2 p-4">
      <div className="mb-4 text-lg font-semibold tracking-tight">Orchestris</div>
      {/* Heç nə işləmirsə komponent `null` qaytarır — boş yer tutmur. */}
      <LiveBar />
      <ul className="space-y-1">
        {LINKS.map((l) => (
          <li key={l.to}>
            <NavLink
              to={l.to}
              end={l.to === '/'}
              className={({ isActive }) =>
                `block rounded px-3 py-2 text-sm transition ${
                  isActive ? 'bg-accent/15 text-accent' : 'text-ink-dim hover:bg-white/5'
                }`
              }
            >
              {l.label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  )
}
