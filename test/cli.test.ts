import { describe, expect, it } from 'vitest'
import { parseCli } from '../src/main/cli'

describe('the command line', () => {
  it('is not a scheduled run by default', () => {
    expect(parseCli([])).toEqual({ syncOnce: false, accountId: null })
  })

  it('reads a scheduled run', () => {
    expect(parseCli(['--sync-once'])).toEqual({ syncOnce: true, accountId: null })
  })

  it('reads the account to run', () => {
    expect(parseCli(['--sync-once', '--account', 'acc_7f3a2b'])).toEqual({
      syncOnce: true,
      accountId: 'acc_7f3a2b',
    })
  })

  it('ignores an account with no id after it', () => {
    expect(parseCli(['--sync-once', '--account'])).toEqual({
      syncOnce: true,
      accountId: null,
    })
  })

  it('ignores an account flag followed by another flag', () => {
    expect(parseCli(['--sync-once', '--account', '--other'])).toEqual({
      syncOnce: true,
      accountId: null,
    })
  })

  it('reads the account whichever way round the flags are', () => {
    expect(parseCli(['--account', 'acc_7f3a2b', '--sync-once'])).toEqual({
      syncOnce: true,
      accountId: 'acc_7f3a2b',
    })
  })
})
