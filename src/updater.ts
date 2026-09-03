import { join } from 'node:path'
import { isNewer } from './update-check.js'

/** What the shell is told. Absent altogether when there is nothing to offer. */
export interface UpdateWire {
  /** The newer version on the registry. */
  latest: string
  phase: 'available' | 'installing' | 'handing-over' | 'failed'
  error?: string
}

export interface UpdaterDeps {
  current: string
  latestVersion: () => Promise<string | null>
  /** Installs `version` somewhere durable and returns that package's root. */
  install: (version: string) => Promise<string>
  /** Starts a daemon from `cliEntry` and resolves once it has taken over the
   *  registry; rejects if it never does. The caller is still serving meanwhile. */
  handover: (cliEntry: string) => Promise<void>
  /** Runs after a successful handover: let go of everything and exit. */
  retire: () => Promise<void>
  onChange: () => void
}

type Phase = 'idle' | 'installing' | 'handing-over' | 'failed'

/** The daemon's one update, from "there is a newer version" to handing its
 *  sessions to it. Daemon-wide by nature - every session's shell shows the same
 *  offer and the same progress. The mechanics (npm, spawning, exiting) are
 *  injected so the sequencing can be tested without them.
 *
 *  Deliberately not in scope: the bundled skill. Its own instructions launch the
 *  CLI as `@latest`, so a stale copy still starts a current review, and its
 *  reader is an agent session this daemon did not spawn and cannot restart - so
 *  there is no moment at which syncing it from here would pay off. */
export class Updater {
  private latest: string | null = null
  private phase: Phase = 'idle'
  private error: string | undefined

  constructor(private readonly deps: UpdaterDeps) {}

  /** The version the update would land on, or null when this one is current. */
  get target(): string | null {
    return this.latest && isNewer(this.latest, this.deps.current) ? this.latest : null
  }

  /** Never rejects. It runs on a timer, unawaited, so a rejection here would be
   *  an unhandled one - and the default for those takes the process down, along
   *  with every review the daemon is holding. Nothing to offer is a fine
   *  outcome; losing the daemon over a failed version check is not. */
  async check(): Promise<void> {
    try {
      const before = JSON.stringify(this.snapshot())
      this.latest = await this.deps.latestVersion()
      if (JSON.stringify(this.snapshot()) !== before) this.deps.onChange()
    } catch {
      /* keep whatever the last check knew */
    }
  }

  snapshot(): UpdateWire | undefined {
    const target = this.target
    // Covers both nothing-to-offer and a run whose target the registry has since
    // withdrawn: with no version ahead of this one there is nothing to say.
    if (!target) return undefined
    return {
      latest: target,
      phase: this.phase === 'idle' ? 'available' : this.phase,
      ...(this.error ? { error: this.error } : {}),
    }
  }

  /** Kick off the update. `busy` while one is in flight; `nothing` when this
   *  daemon is already current. A failed run can be started again. */
  run(): 'started' | 'busy' | 'nothing' {
    if (this.phase !== 'idle' && this.phase !== 'failed') return 'busy'
    const target = this.target
    if (!target) return 'nothing'
    this.error = undefined
    void this.execute(target)
    return 'started'
  }

  private set(phase: Phase): void {
    this.phase = phase
    this.deps.onChange()
  }

  private async execute(target: string): Promise<void> {
    try {
      this.set('installing')
      const pkgRoot = await this.deps.install(target)
      this.set('handing-over')
      await this.deps.handover(join(pkgRoot, 'dist', 'cli.mjs'))
      await this.deps.retire()
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err)
      this.set('failed')
    }
  }
}
