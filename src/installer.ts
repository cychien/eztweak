import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { PKG_NAME, VERSIONS_DIR } from './constants.js'

/** npm's entry point, run with this very node rather than whatever `npm` on
 *  PATH would pick: the daemon has no shell of the user's to inherit one from.
 *  Unix installs keep it beside node under `lib/`, Windows ones beside the exe. */
function npmCli(): string | null {
  const bin = dirname(process.execPath)
  for (const candidate of [
    join(bin, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** What npm's stderr amounts to, for a card in the shell: its own `npm error`
 *  lines with the prefix off and the log-file pointer dropped, else the last
 *  line of whatever it did say. */
export function npmErrorSummary(stderr: string): string {
  const lines = stderr.split('\n').map((l) => l.trim())
  const own = lines
    .filter((l) => /^npm (error|ERR!)/.test(l))
    .map((l) => l.replace(/^npm (error|ERR!)\s*/, ''))
    .filter((l) => l && !/^A complete log of this run/.test(l))
  if (own.length) return own.slice(0, 2).join(' ')
  return lines.filter(Boolean).at(-1) ?? ''
}

function run(
  label: string,
  command: string,
  args: string[],
  opts: { shell?: boolean } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: opts.shell })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c: Buffer) => (stdout += c))
    child.stderr.on('data', (c: Buffer) => (stderr += c))
    child.on('error', (err) => reject(new Error(`${label} could not start: ${err.message}`)))
    // `close`, not `exit`: the stdio streams can still be open when `exit`
    // fires, and both callers read the output - one compares the whole of
    // stdout against a version, the other reports stderr to the user.
    child.on('close', (code) => {
      if (code === 0) return resolve({ stdout, stderr })
      const why = npmErrorSummary(stderr)
      reject(new Error(`${label} failed${why ? `: ${why}` : ` (exit ${code})`}`))
    })
  })
}

/** `shell: true` hands the argv to a shell as one string with no quoting of its
 *  own, so anything a shell would split has to be quoted here. Only reached on
 *  the fallback path, where a home directory with a space in it is otherwise
 *  read as two arguments. */
export function shellQuote(arg: string): string {
  if (process.platform === 'win32') return /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`
}

async function npm(label: string, args: string[]): Promise<void> {
  const cli = npmCli()
  if (cli) {
    await run(label, process.execPath, [cli, ...args])
    return
  }
  await run(label, process.platform === 'win32' ? 'npm.cmd' : 'npm', args.map(shellQuote), {
    shell: true,
  })
}

export function installedPackageRoot(version: string): string {
  return join(VERSIONS_DIR, version, 'node_modules', PKG_NAME)
}

/** Whether the install at `pkgRoot` runs and is the version it should be. */
async function verifyInstall(pkgRoot: string, version: string): Promise<boolean> {
  const cliEntry = join(pkgRoot, 'dist', 'cli.mjs')
  if (!existsSync(cliEntry)) return false
  try {
    const { stdout } = await run(`${PKG_NAME} --version`, process.execPath, [cliEntry, '--version'])
    return stdout.trim() === version
  } catch {
    return false
  }
}

/** Install `version` under the data dir and prove it runs. Returns the package
 *  root. Nothing here touches the running daemon, so a failure leaves it as it
 *  was - and a retry after one skips the download, since the install is still there. */
export async function installVersion(version: string): Promise<string> {
  const pkgRoot = installedPackageRoot(version)
  if (await verifyInstall(pkgRoot, version)) return pkgRoot
  const prefix = join(VERSIONS_DIR, version)
  mkdirSync(prefix, { recursive: true })
  await npm(`npm install ${PKG_NAME}@${version}`, [
    'install',
    '--prefix',
    prefix,
    '--no-audit',
    '--no-fund',
    '--no-package-lock',
    '--loglevel=error',
    `${PKG_NAME}@${version}`,
  ])
  if (!(await verifyInstall(pkgRoot, version))) {
    throw new Error(`the installed ${PKG_NAME}@${version} does not run as v${version}`)
  }
  return pkgRoot
}

/** Symlinks resolved, because that is the only way two paths for one directory
 *  compare equal - and `import.meta.url` arrives already resolved while a path
 *  built from an env var does not. A macOS data dir under `/tmp` (a link to
 *  `/private/tmp`) is enough to make the difference. */
function realOrResolved(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/** Drop every installed version but the one `runningFrom` (a cli entry path)
 *  belongs to. Only versions under the data dir are ever removed, and a version
 *  whose directory cannot be told apart from the running one is kept: deleting
 *  the tree this daemon serves its shell assets from would break every session
 *  it holds. */
export function pruneInstalledVersions(runningFrom: string, root = VERSIONS_DIR): void {
  let versions: string[]
  try {
    versions = readdirSync(root)
  } catch {
    return
  }
  const running = realOrResolved(runningFrom)
  for (const version of versions) {
    const dir = join(root, version)
    if (running.startsWith(realOrResolved(dir) + sep)) continue
    rmSync(dir, { recursive: true, force: true })
  }
}
