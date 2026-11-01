import { describe, expect, it } from 'vitest'
import {
  TASK_NAME,
  buildDeleteArgs,
  buildSchtasksArgs,
  taskNameFor,
} from '../src/main/taskScheduler'

describe('the Windows scheduled task', () => {
  const exe = 'C:\\Program Files\\Drive Mirror\\Drive Mirror.exe'
  const next = new Date('2026-03-01T10:00:00')
  const account = 'acc_7f3a2b'
  const email = 'you@example.com'

  it('asks for an hourly task', () => {
    const args = buildSchtasksArgs({ kind: 'every-hours', everyHours: 6 }, exe, next, account, email)
    expect(args).toContain('/SC')
    expect(args[args.indexOf('/SC') + 1]).toBe('HOURLY')
    expect(args).toContain('/MO')
    expect(args[args.indexOf('/MO') + 1]).toBe('6')
  })

  it('asks for a daily task at a time', () => {
    const args = buildSchtasksArgs({ kind: 'daily', at: '02:00' }, exe, next, account, email)
    expect(args[args.indexOf('/SC') + 1]).toBe('DAILY')
    expect(args[args.indexOf('/ST') + 1]).toBe('02:00')
  })

  it('asks for a task every n days', () => {
    const args = buildSchtasksArgs({ kind: 'every-days', everyDays: 3 }, exe, next, account, email)
    expect(args[args.indexOf('/SC') + 1]).toBe('DAILY')
    expect(args[args.indexOf('/MO') + 1]).toBe('3')
    expect(args[args.indexOf('/ST') + 1]).toBe('10:00')
  })

  it('asks for a weekly task on a day', () => {
    const args = buildSchtasksArgs({ kind: 'weekly', day: 3, at: '03:00' }, exe, next, account, email)
    expect(args[args.indexOf('/SC') + 1]).toBe('WEEKLY')
    expect(args[args.indexOf('/D') + 1]).toBe('WED')
    expect(args[args.indexOf('/ST') + 1]).toBe('03:00')
  })

  it('runs the app in the user session, without a stored password', () => {
    const args = buildSchtasksArgs({ kind: 'daily', at: '02:00' }, exe, next, account, email)
    expect(args).toContain('/IT')
    expect(args).not.toContain('/RP')
    expect(args).not.toContain('/RU')
  })

  it('quotes the command so a path with spaces works', () => {
    const args = buildSchtasksArgs({ kind: 'daily', at: '02:00' }, exe, next, account, email)
    const tr = args[args.indexOf('/TR') + 1]!
    // The path is quoted so the spaces in it stay part of the path; the
    // flags are bare tokens after it.
    expect(tr).toBe(
      '"C:\\Program Files\\Drive Mirror\\Drive Mirror.exe" --sync-once --account acc_7f3a2b',
    )
    expect(tr).toContain('--sync-once')
  })

  it('tells the task which account to run', () => {
    const args = buildSchtasksArgs({ kind: 'daily', at: '02:00' }, exe, next, account, email)
    expect(args[args.indexOf('/TR') + 1]).toContain('--account acc_7f3a2b')
  })

  it('names the task after the account, so two accounts have two tasks', () => {
    expect(taskNameFor('you@example.com')).toBe('Drive Mirror Sync - you@example.com')
    const args = buildSchtasksArgs({ kind: 'daily', at: '02:00' }, exe, next, account, email)
    expect(args[args.indexOf('/TN') + 1]).toBe(taskNameFor(email))
  })

  it('deletes by the same name it creates', () => {
    expect(buildDeleteArgs(email)).toContain(taskNameFor(email))
    expect(buildDeleteArgs(email)).toContain('/Delete')
  })

  it('names the task the same way every time', () => {
    const args = buildSchtasksArgs({ kind: 'daily', at: '02:00' }, exe, next, account, email)
    expect(args[args.indexOf('/TN') + 1]).toBe('Drive Mirror Sync - you@example.com')
  })

  it('forces the task to be replaced rather than refused', () => {
    const args = buildSchtasksArgs({ kind: 'daily', at: '02:00' }, exe, next, account, email)
    expect(args).toContain('/F')
  })

  it('keeps the old task name, for the migration to remove it', () => {
    expect(TASK_NAME).toBe('Drive Mirror Sync')
  })
})
