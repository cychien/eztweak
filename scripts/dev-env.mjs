import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
export const DEV_DATA_DIR = join(REPO_ROOT, '.dev')
export const FIXTURE_ROOT = join(REPO_ROOT, 'fixtures/playground')
export const CLI = join(REPO_ROOT, 'dist/cli.mjs')
/** The url `npm run dev` is currently serving, so companion scripts do not have
 *  to guess when the daemon has restored older sessions from previous runs. */
export const TARGET_FILE = join(DEV_DATA_DIR, 'target.json')

/** A dev daemon must differ from the real one in *both* of these. The data dir
 *  separates registry and sessions; the control port keeps `daemonMain` from
 *  finding the real daemon in its range and adopting it instead of starting. */
export const DEV_CONTROL_PORT = 4410

export const devEnv = {
  ...process.env,
  EZTWEAK_DATA_DIR: DEV_DATA_DIR,
  EZTWEAK_CONTROL_PORT: String(DEV_CONTROL_PORT),
}

export function runCli(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: devEnv,
      stdio: opts.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    })
    let out = ''
    child.stdout?.on('data', (c) => {
      out += c
    })
    child.on('error', reject)
    child.on('exit', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`eztweak ${args[0]} exited with ${code}`)),
    )
  })
}

export const delay = (ms) => new Promise((r) => setTimeout(r, ms))

export function devTargetUrl() {
  try {
    return JSON.parse(readFileSync(TARGET_FILE, 'utf8')).url
  } catch {
    throw new Error('no dev session on record - run `npm run dev` first')
  }
}
