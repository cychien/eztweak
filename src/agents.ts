/** The agents a review can be driven by.
 *
 *  A profile is a short name for the command line that starts that agent's ACP
 *  server. Shared by the CLI's `--agent` flag and the shell's picker so the two
 *  cannot drift into offering different things under the same name. */

import { delimiter, join } from 'node:path'
import { accessSync, constants } from 'node:fs'

export interface AgentProfile {
  id: string
  /** What the shell shows. */
  name: string
  /** Shell command that starts the agent's ACP server on stdio. */
  command: string
  /** The CLI this profile ultimately drives, for the "is it installed" check.
   *  Not the same as `command`: two of these start through `npx`, which fetches
   *  the adapter but cannot conjure the agent behind it. */
  binary: string
}

export const AGENT_PROFILES: AgentProfile[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    command: 'npx -y @agentclientprotocol/claude-agent-acp',
    binary: 'claude',
  },
  {
    id: 'codex',
    name: 'Codex',
    command: 'npx -y @agentclientprotocol/codex-acp',
    binary: 'codex',
  },
  { id: 'gemini', name: 'Gemini CLI', command: 'gemini --experimental-acp', binary: 'gemini' },
]

/** A profile's command, or the argument itself when it names no profile - which
 *  is how a custom ACP server is started. */
export function agentCommand(agent: string): string {
  return AGENT_PROFILES.find((p) => p.id === agent)?.command ?? agent
}

/** The profile a running command came from, if any. Matched on the command
 *  rather than remembered as an id, because the command is what is persisted
 *  with the session and what a chat is keyed by. */
export function agentProfileFor(command: string): AgentProfile | undefined {
  return AGENT_PROFILES.find((p) => p.command === command)
}

/** Whether this profile's CLI is on the PATH.
 *
 *  Advisory only, and the picker says so rather than hiding what fails the
 *  check: an agent can be installed somewhere this cannot see, and the honest
 *  report of a launch that does not work is the launch failing with its own
 *  error in the thread. */
export function agentInstalled(profile: AgentProfile, env = process.env): boolean {
  const path = env.PATH ?? ''
  return path
    .split(delimiter)
    .filter(Boolean)
    .some((dir) => {
      try {
        accessSync(join(dir, profile.binary), constants.X_OK)
        return true
      } catch {
        return false
      }
    })
}
