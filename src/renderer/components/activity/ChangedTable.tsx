import type { JSX } from 'react'
import type { RunSummary } from '../../../main/ipc'

interface ChangedTableProps {
  changed: RunSummary['changed']
}

export function ChangedTable({ changed }: ChangedTableProps): JSX.Element {
  return (
    <section className="changed">
      <h2 className="changed__title">Changed files</h2>
      {changed.length === 0 ? (
        <div className="changed__empty">
          <p>Nothing changed in the last run — all files are up to date.</p>
        </div>
      ) : (
        <table className="changed__table">
          <thead>
            <tr>
              <th>Folder</th>
              <th>File</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {changed.map((entry) => (
              <tr key={`${entry.mirror}|${entry.relPath}|${entry.action}`}>
                <td className="changed__folder">{entry.mirror}</td>
                <td className="changed__file" title={entry.relPath}>
                  {entry.relPath.split('/').pop() ?? entry.relPath}
                </td>
                <td className="changed__action">{entry.action}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
