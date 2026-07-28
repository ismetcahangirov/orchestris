import { NavLink } from 'react-router-dom'

const LINKS = [
  { to: '/', label: 'İdarə paneli' },
  { to: '/contexts', label: 'Kontekstlər' },
  { to: '/providers', label: 'Provayderlər' },
  { to: '/ladder', label: 'Nərdivan' },
  { to: '/history', label: 'Tarixçə' },
] as const

export default function Sidebar(): React.JSX.Element {
  return (
    <nav className="w-56 shrink-0 border-r border-white/10 bg-surface-2 p-4">
      <div className="mb-6 text-lg font-semibold tracking-tight">Orchestris</div>
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
