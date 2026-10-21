#!/usr/bin/env node
/**
 * Typecheck the two TypeScript projects.
 *
 * `tsconfig.web.json` covers the renderer, which does not exist until the
 * renderer task. `tsc` reports "no inputs were found" (TS18003) for an empty
 * project; that is the one diagnostic we tolerate. Every other error fails
 * the check.
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

const projects = ['tsconfig.node.json', 'tsconfig.web.json']
const TOLERATED = /error TS18003: No inputs were found/

let failed = false

for (const project of projects) {
  const result = spawnSync(
    process.execPath,
    [join('node_modules', 'typescript', 'bin', 'tsc'), '--noEmit', '-p', project],
    { encoding: 'utf8', shell: false },
  )

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const lines = output.split(/\r?\n/).filter((l) => l.trim().length > 0)
  const errors = lines.filter((l) => !TOLERATED.test(l))

  if (errors.length > 0) {
    failed = true
    console.error(`--- ${project} ---`)
    for (const line of errors) console.error(line)
  } else {
    const note = lines.length > 0 ? ' (no inputs yet)' : ''
    console.log(`ok  ${project}${note}`)
  }
}

process.exit(failed ? 1 : 0)
