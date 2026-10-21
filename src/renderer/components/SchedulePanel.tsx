import { useState } from 'react'
import type { JSX } from 'react'
import type { ScheduleConfig, ScheduleShape } from '../../main/settings'

export interface SchedulePanelProps {
  schedule: ScheduleConfig
  onSave: (patch: Partial<ScheduleConfig>) => Promise<void>
  onRunNow: () => void
}

/** The days of the week, as the schedule names them. */
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/**
 * When the app syncs on its own.
 *
 * One schedule, and one way to run it. The in-app timer runs while the app
 * is open; a Windows task runs when it is not. Only one of the two is ever
 * on, because two would mean two syncs per slot.
 */
export function SchedulePanel({
  schedule,
  onSave,
  onRunNow,
}: SchedulePanelProps): JSX.Element {
  const [shape, setShape] = useState<ScheduleShape>(schedule.shape)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')

  async function save(patch: Partial<ScheduleConfig>): Promise<void> {
    setBusy(true)
    setStatus('')
    try {
      await onSave(patch)
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'The schedule was not saved.')
    } finally {
      setBusy(false)
    }
  }

  function setShapeAndSave(next: ScheduleShape): void {
    setShape(next)
    void save({ shape: next })
  }

  return (
    <section className="dialog__section">
      <h3>Running on a schedule</h3>

      <label className="field">
        <span className="field__label">How often</span>
        <select
          className="field__input"
          value={shape.kind}
          onChange={(event) => {
            const kind = event.target.value as ScheduleShape['kind']
            if (kind === 'every-hours') setShapeAndSave({ kind, everyHours: 6 })
            else if (kind === 'daily') setShapeAndSave({ kind, at: '02:00' })
            else if (kind === 'every-days') setShapeAndSave({ kind, everyDays: 3 })
            else setShapeAndSave({ kind, day: 3, at: '03:00' })
          }}
        >
          <option value="every-hours">Every few hours</option>
          <option value="daily">Every day</option>
          <option value="every-days">Every few days</option>
          <option value="weekly">Once a week</option>
        </select>
      </label>

      {shape.kind === 'every-hours' && (
        <NumberField
          label="Every how many hours"
          value={shape.everyHours}
          min={1}
          max={23}
          onChange={(everyHours) => setShapeAndSave({ kind: 'every-hours', everyHours })}
        />
      )}

      {shape.kind === 'every-days' && (
        <NumberField
          label="Every how many days"
          value={shape.everyDays}
          min={1}
          max={31}
          onChange={(everyDays) => setShapeAndSave({ kind: 'every-days', everyDays })}
        />
      )}

      {shape.kind === 'daily' && (
        <TimeField
          label="At what time"
          value={shape.at}
          onChange={(at) => setShapeAndSave({ kind: 'daily', at })}
        />
      )}

      {shape.kind === 'weekly' && (
        <>
          <label className="field">
            <span className="field__label">On which day</span>
            <select
              className="field__input"
              value={shape.day}
              onChange={(event) =>
                setShapeAndSave({ kind: 'weekly', day: Number(event.target.value), at: shape.at })
              }
            >
              {DAYS.map((day, index) => (
                <option key={day} value={index}>
                  {day}
                </option>
              ))}
            </select>
          </label>
          <TimeField
            label="At what time"
            value={shape.at}
            onChange={(at) => setShapeAndSave({ kind: 'weekly', day: shape.day, at })}
          />
        </>
      )}

      <label className="field">
        <span className="field__label">How it runs</span>
        <select
          className="field__input"
          value={schedule.mechanism}
          onChange={(event) =>
            void save({ mechanism: event.target.value as ScheduleConfig['mechanism'] })
          }
        >
          <option value="in-app">While the app is open</option>
          <option value="windows-task">Even when the app is closed</option>
        </select>
        <span className="field__hint">
          {schedule.mechanism === 'windows-task'
            ? 'A task is registered with Windows. It runs only while you are signed in, because the app’s credentials are encrypted with your Windows account.'
            : 'The app syncs on a timer while it is open. Close it and nothing runs.'}
        </span>
      </label>

      <div className="dialog__row">
        <label className="field field--inline">
          <input
            type="checkbox"
            checked={schedule.enabled}
            onChange={(event) => void save({ enabled: event.target.checked })}
          />
          <span>Sync on this schedule</span>
        </label>
        <button
          type="button"
          className="button button--quiet"
          disabled={busy}
          onClick={onRunNow}
        >
          Sync now
        </button>
      </div>

      {schedule.nextRunAt && (
        <p className="field__hint">The next run is due at {schedule.nextRunAt}.</p>
      )}
      {status && <p className="dialog__status">{status}</p>}
    </section>
  )
}

function NumberField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  onChange: (value: number) => void
}): JSX.Element {
  const [draft, setDraft] = useState(String(value))
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      <input
        className="field__input field__input--number"
        type="number"
        min={min}
        max={max}
        value={draft}
        // The value is kept until the field is left, so a half-typed
        // number is never sent to the app.
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          const next = Number(draft)
          if (Number.isFinite(next) && next >= min && next <= max) {
            onChange(next)
          } else {
            setDraft(String(value))
          }
        }}
      />
    </label>
  )
}

function TimeField({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (value: string) => void
}): JSX.Element {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      <input
        className="field__input"
        type="time"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  )
}
