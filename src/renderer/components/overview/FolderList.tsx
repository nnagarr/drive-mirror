import type { JSX } from 'react'
import type { MirrorCard } from '../../../main/ipc'
import { FolderRow } from './FolderRow'

interface FolderListProps {
  mirrors: MirrorCard[]
  onSync: (name: string) => void
  onEdit: (name: string) => void
  onPauseResume?: (name: string, enabled: boolean) => void
}

export function FolderList({ mirrors, onSync, onEdit, onPauseResume }: FolderListProps): JSX.Element {
  return (
    <section className="folder-list" aria-label="Folders">
      {mirrors.map((mirror) => (
        <FolderRow
          key={mirror.name}
          mirror={mirror}
          onSync={onSync}
          onEdit={onEdit}
          onPauseResume={onPauseResume}
        />
      ))}
    </section>
  )
}
