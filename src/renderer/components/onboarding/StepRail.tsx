import type { JSX } from 'react'

const STEPS = [
  { id: 1, label: 'Create a Google Cloud project' },
  { id: 2, label: 'Turn on the Drive API' },
  { id: 3, label: 'Create a Desktop OAuth client' },
  { id: 4, label: 'Publish the consent screen' },
  { id: 5, label: 'Paste the client id and secret' },
]

interface StepRailProps {
  current: number
  done: Set<number>
  onSelect: (step: number) => void
}

export function StepRail({ current, done, onSelect }: StepRailProps): JSX.Element {
  return (
    <aside className="onboarding-rail">
      <h1 className="onboarding-rail__headline">Set up Google Drive.</h1>
      <p className="onboarding-rail__lead">
        The app talks to Drive as you, with your own Google account. It needs a client
        id and secret of your own.
      </p>
      <ol className="onboarding-rail__steps">
        {STEPS.map((step) => (
          <li
            key={step.id}
            className={`onboarding-rail__step ${current === step.id ? 'onboarding-rail__step--active' : ''} ${
              done.has(step.id) ? 'onboarding-rail__step--done' : ''
            }`}
          >
            <button type="button" className="onboarding-rail__step__button" onClick={() => onSelect(step.id)}>
              <span className="onboarding-rail__step__number">{step.id}</span>
              <span className="onboarding-rail__step__label">{step.label}</span>
              {done.has(step.id) && <span className="onboarding-rail__step__check" aria-hidden="true">✓</span>}
            </button>
          </li>
        ))}
      </ol>
    </aside>
  )
}
