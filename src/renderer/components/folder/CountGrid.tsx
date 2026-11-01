import type { JSX } from 'react'

/** The five-column count grid: Uploaded, Updated, Downloaded, Moved to trash,
 * Errors. Zero values are muted. */
interface CountGridProps {
  counts: {
    uploaded: number
    updated: number
    downloaded: number
    trashed: number
    errors: number
  }
}

const COLUMNS: Array<{ key: keyof CountGridProps['counts']; label: string }> = [
  { key: 'uploaded', label: 'Uploaded' },
  { key: 'updated', label: 'Updated' },
  { key: 'downloaded', label: 'Downloaded' },
  { key: 'trashed', label: 'Moved to trash' },
  { key: 'errors', label: 'Errors' },
]

export function CountGrid({ counts }: CountGridProps): JSX.Element {
  return (
    <div className="count-grid" role="list" aria-label="Last run">
      {COLUMNS.map((column) => {
        const value = counts[column.key]
        return (
          <div key={column.key} className="count">
            <span className={`value ${value === 0 ? 'count--zero' : ''}`}>{value}</span>
            <span className="label">{column.label}</span>
          </div>
        )
      })}
    </div>
  )
}
