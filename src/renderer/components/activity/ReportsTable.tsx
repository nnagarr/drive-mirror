import type { JSX } from 'react'
import type { Report } from '../../../core/types'

interface ReportsTableProps {
  reports: Report[]
}

export function ReportsTable({ reports }: ReportsTableProps): JSX.Element {
  return (
    <section className="reports">
      <h2 className="reports__title">
        Left alone
        <span className="reports__sub">Files the app deliberately did not touch, and why.</span>
      </h2>
      <table className="reports__table">
        <thead>
          <tr>
            <th>Folder</th>
            <th>Path</th>
            <th>Why</th>
          </tr>
        </thead>
        <tbody>
          {reports.map((report) => (
            <tr key={`${report.code}|${report.relPath}`}>
              <td className="reports__folder">{report.relPath ? report.relPath.split('/')[0] : 'All folders'}</td>
              <td className="reports__path" title={report.relPath}>
                {report.relPath || '—'}
              </td>
              <td className="reports__why">
                <span className="reports__code">{report.code}</span>
                <span className="reports__message">{report.message}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
