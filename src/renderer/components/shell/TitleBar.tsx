import { useState } from 'react'
import type { JSX } from 'react'

/** The custom titlebar. The real window controls stay native; this bar is
 * the drag region and the app's branding strip. */
interface TitleBarProps {
  /** What is shown in the app section (Overview / Activity / Settings). */
  section?: string
  /** The account's avatar URL or app icon data URI. */
  icon?: string
}

export function TitleBar({ section, icon }: TitleBarProps): JSX.Element {
  const [loadError, setLoadError] = useState(false)

  return (
    <header className="titlebar" role="banner">
      <div className="titlebar__brand">
        {icon && !loadError ? (
          <img
            className="titlebar__icon"
            src={icon}
            alt=""
            onError={() => setLoadError(true)}
          />
        ) : (
          <svg
            className="titlebar__icon titlebar__icon--fallback"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
        )}
        <span className="titlebar__app">Drive Mirror</span>
      </div>
      {section && <span className="titlebar__section">{section}</span>}
      <div className="titlebar__drag" aria-hidden="true" />
    </header>
  )
}
