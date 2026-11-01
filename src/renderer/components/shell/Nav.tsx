import type { JSX } from 'react'

interface NavProps {
  /** Which section is active. */
  view: 'overview' | 'activity' | 'settings'
  /** Switch to a section. */
  onSelect: (view: 'overview' | 'activity' | 'settings') => void
}

export function Nav({ view, onSelect }: NavProps): JSX.Element {
  const items: { id: 'overview' | 'activity' | 'settings'; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'activity', label: 'Activity' },
    { id: 'settings', label: 'Settings' },
  ]

  return (
    <nav className="nav" aria-label="Sections">
      <ul className="nav__list">
        {items.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              className={`nav__item ${view === item.id ? 'nav__item--active' : ''}`}
              aria-pressed={view === item.id}
              onClick={() => void onSelect(item.id)}
            >
              {item.label}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  )
}
