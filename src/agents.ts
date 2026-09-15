/** The agents a review can be driven by.
 *
 *  A profile is a short name for the command line that starts that agent's ACP
 *  server. Shared by the CLI's `--agent` flag and the shell's picker so the two
 *  cannot drift into offering different things under the same name. */

/** Whose models an agent runs, for the mark shown beside one. An agent is not a
 *  brand - Claude Code is not Anthropic - but the model it is about to answer
 *  with belongs to one, and a model named only "6 Astra" does not say whose. */
export type AgentBrand = 'claude' | 'openai'

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
  brand?: AgentBrand
}

export const AGENT_PROFILES: AgentProfile[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    command: 'npx -y @agentclientprotocol/claude-agent-acp',
    binary: 'claude',
    brand: 'claude',
  },
  {
    id: 'codex',
    name: 'Codex',
    command: 'npx -y @agentclientprotocol/codex-acp',
    binary: 'codex',
    brand: 'openai',
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

/** Whose models the running agent answers with, when it is one we know. */
export function agentBrandFor(command: string): AgentBrand | undefined {
  return agentProfileFor(command)?.brand
}
