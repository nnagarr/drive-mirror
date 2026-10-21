import { describe, expect, it } from 'vitest'
import { clearPendingNotice, setPendingNotice } from '../src/main/notice'
import { defaultSettings } from '../src/main/settings'

describe('a notice the user did not see', () => {
  it('is set and then cleared', async () => {
    const s = defaultSettings()
    const withNotice = await setPendingNotice(
      s,
      'the sync failed',
      new Date('2026-03-01T10:00:00.000Z'),
    )
    expect(withNotice.pendingNotice?.message).toBe('the sync failed')
    expect(withNotice.pendingNotice?.at).toBe('2026-03-01T10:00:00.000Z')
    expect((await clearPendingNotice(withNotice)).pendingNotice).toBeNull()
  })

  it('does not mutate the settings it was given', async () => {
    const s = defaultSettings()
    await setPendingNotice(s, 'x', new Date())
    expect(s.pendingNotice).toBeNull()
  })

  it('ignores a notice that is not a message', async () => {
    const s = defaultSettings()
    const withNotice = await setPendingNotice(s, 42 as never, new Date())
    expect(withNotice.pendingNotice).toBeNull()
  })

  it('ignores an empty message', async () => {
    const s = defaultSettings()
    expect((await setPendingNotice(s, '', new Date())).pendingNotice).toBeNull()
  })

  it('replaces a notice that is already there', async () => {
    const s = defaultSettings()
    const first = await setPendingNotice(s, 'the first thing', new Date())
    const second = await setPendingNotice(first, 'the second thing', new Date())
    expect(second.pendingNotice?.message).toBe('the second thing')
  })
})
