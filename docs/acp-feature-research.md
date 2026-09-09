# ACP feature research: session restore, skill list, model switching

Verified against ACP SDK `1.4.0`, `@agentclientprotocol/claude-agent-acp` `0.75.1`,
`@agentclientprotocol/codex-acp` `1.10.0`, and the Claude Code `2.1.266` binary's own
control-protocol schema.

**Status.** Model switching is built. Session restore is designed and agreed, not yet built.
The skill list is research only.

## Summary

| Feature | Reachable over ACP? | What blocks it |
| --- | --- | --- |
| Model switching | Yes, protocol-native, works on both `claude` and `codex` | Nothing |
| Conversation restore | Yes, `claude` only | Needs capability gating; the SDK's `ActiveSession` only wraps `session/new` |
| Code-change restore | **No** | ACP has no rewind/checkpoint at all. Has to be built here |
| Skill list + per-skill toggle | **No protocol support** | Enumeration has no honest source; toggling needs a vendor `_meta` channel and a session rebuild |

Suggested order: **model switching -> session restore -> skills**. Skills depends on the session
rebuild machinery that session restore introduces, and its enumeration half may be better solved
upstream than worked around here.

---

## 1. Model switching

### Protocol

ACP 1.4.0 carries a generic `SessionConfigOption` list. `session/new`, `session/load`,
`session/fork` and `session/resume` all return `configOptions`, and the model selector is one entry
in it:

```ts
{
  id: 'model',
  name: 'Model',
  description: 'AI model to use',
  category: 'model',          // 'mode' | 'model' | 'model_config' | 'thought_level' | string
  type: 'select',
  currentValue: SessionConfigValueId,
  options: SessionConfigSelectOption[] | SessionConfigSelectGroup[],
}
```

- Change it with `session/set_config_option` -> `{ sessionId, configId: 'model', value }`, which
  answers with the full refreshed `configOptions`.
- The agent also pushes `config_option_update` (`{ configOptions }`) as a `session/update`
  whenever it changes the set for any reason of its own.

`category` is explicitly UX-only ("MUST NOT be required for correctness"), and clients must handle
unknown categories gracefully.

### What `claude-agent-acp` does with it

`setSessionConfigOption` on the `model` branch calls `await session.query.setModel(resolvedValue)` -
a live switch on the running query. **No subprocess restart, no new session, conversation context
preserved.** It also:

- resolves human aliases, so `'opus'` and `'sonnet'` are accepted as well as full ids;
- accepts the current `currentValue` even when it is not in `options` (a session resumed onto a
  model the picker no longer offers), so round-tripping the reported value never errors;
- rebuilds the dependent options after a switch, because effort levels are per-model;
- pushes `config_option_update` on switches it did not initiate - a refusal fallback, or the model
  being changed by something else (`syncModelAfterExternalSwitch`).

Alongside `model` it may offer:

| id | category | Shape | Notes |
| --- | --- | --- | --- |
| `mode` | `mode` | select | Also settable via `session/set_mode` |
| `effort` | `thought_level` | select | Only when the current model supports effort; values from `supportedEffortLevels` |
| `fast` | `model_config` | boolean, or on/off select | Only when the model supports Fast mode |
| `agent` | (none) | select | Only when the user has custom agents configured |

`fast` arrives as a native `type: 'boolean'` only if the client advertises
`clientCapabilities.session.configOptions.boolean = {}`; otherwise the agent degrades it to a
two-value select. `effort` and `agent` are applied through `query.applyFlagSettings(...)`, also live.

`setSessionConfigOption` throws on: unknown session, unknown `configId`, a non-string value for a
select, an unresolvable value, and a closed query stream (`SESSION_ENDED_MESSAGE`). A switch can also
be refused by a `PreModelSwitch` hook ("Model switch blocked by a PreModelSwitch hook"), so a
request that returns without error is still not proof the model changed. The UI must mirror the
snapshot rather than assume its own optimistic value.

### Measured behaviour

Probed against `claude-agent-acp` 0.75.1 driving Claude Code 2.1.266 over a raw ndjson ACP client.

**Context survives a model switch.** Turn 1 on `opus[1m]` was told to remember `4718`; the model was
switched to `claude-fable-5-1[1m]`; turn 2 answered `4718` and turn 3 identified as `Fable 5.1`. The
switch is live on the same query, so nothing is replayed and nothing is lost.

**Options appear and disappear with the model**, they do not merely change value:

| Current model | `configOptions` |
| --- | --- |
| `opus[1m]` | `mode`, `model`, `effort`, `fast` |
| `sonnet` | `mode`, `model`, `effort` |
| `haiku` | `mode`, `model` |

Any fixed-slot rendering is therefore wrong, and any UI that reserves permanent space for the list
changes height as the model changes.

**A model switch silently downgrades the permission mode, and does not restore it.** `mode` was
`auto` at `session/new`; switching to `haiku` (no Auto-mode support) moved it to `acceptEdits` via
the adapter's `reconcileForModel`, and switching on to `sonnet` left it at `acceptEdits`. So a user
who briefly picks a cheap model ends the session on "Automatically accept all file edits" with
nothing having said so. Two consequences: `current_mode_update` fires on an ordinary model switch,
so handling `config_option_update` alone is not enough; and surfacing `mode` in the UI is what makes
this visible at all rather than a nicety.

**Mid-turn switching is accepted and harmless.** `session/set_config_option` mid-turn returned
successfully with the new `currentValue`, and the in-flight turn still finished `end_turn`. The
CLI's own wording ("This model switch is still pending ...; it will apply when that completes unless
it is refused") says it applies from the next turn. The cost is a display that names the new model
while the running turn is still on the old one, which is also what the Claude Code CLI does.

**Real option labels**, which decide how much room the control needs:

```
mode   "Mode"      Manual | Accept edits | Plan | Auto | Bypass permissions
model  "Model"     Default (recommended) | Opus (1M context) | Fable | Sonnet | Haiku
effort "Effort"    Default | Low | Medium | High | Xhigh | Max
fast   "Fast mode" boolean
```

Four pills side by side read `Auto  Opus (1M context)  Default  Fast mode`, about 290px against
roughly 308px of usable sidebar width. Too tight to rely on, so the model belongs inline on its own
(label shortened to the text before `" ("`, full name and description in the `title`) with the
remaining options inside the menu it opens.

### `codex-acp`

Ships `MODEL_CONFIG_ID = 'model'`, `session/set_config_option`, and `config_option_update`. So this
is the one feature of the three that is not Claude-specific.

### What eztweak has to change

1. `AcpAgent.onUpdate` currently ends in `default: return`, which drops `config_option_update`,
   `current_mode_update`, `available_commands_update`, `session_info_update` and `usage_update`.
   At minimum `config_option_update` has to be handled.
2. The initial list is on `ActiveSession.newSessionResponse.configOptions`, read in `openSession()`.
3. `AcpSnapshot` needs the option list; `daemon.ts` needs a `POST /acp/config` beside
   `/acp/answer`, `/acp/cancel` and `/acp/new`.
4. **The picked model must survive `/new` and a daemon restart.** `newChat()` opens a fresh ACP
   session and `restoreAcpAgent()` re-spawns the agent, and both land on the agent's default.
   The pick therefore belongs in `PersistedSession`.
5. **Ordering hazard.** `openSession()` does `this.state = 'idle'; this.opts.onChange()`, and
   `onChange` runs `deliverToAcp()`, which prompts immediately if a batch is queued. Re-applying a
   remembered model *after* that point means the first turn of every new session runs on the wrong
   model. The re-apply has to complete while the state is still `'starting'`.
6. The picker must render from the snapshot only, never from local optimistic state - the agent can
   change the model without being asked, and a `PreModelSwitch` hook can refuse one that was.
7. `onUpdate` has to handle `current_mode_update` as well as `config_option_update`; an ordinary
   model switch emits the former (see the mode-downgrade finding above).
8. The control has to be built once outside `render()` and only painted from the snapshot, the way
   `noteAttach.wrap` already is. `render()` rebuilds the queue and thread on every snapshot, and
   snapshots arrive on every `onChange` during a turn, so a control rebuilt with them would close
   its own menu under the user's cursor.

### Decisions taken (implemented)

- **Generic `configOptions` renderer**, not a model-specific field: dispatch on `type`
  (`select` / `boolean`), order by `category`, map known ids to Chinese labels and fall back to the
  agent's `name`. Skip unknown `type`s rather than failing. Handle both
  `SessionConfigSelectOption[]` and `SessionConfigSelectGroup[]`, which the type permits.
- **Placement**: in the composer, above the note box. One always-inline pill for the model, with the
  remaining options in the menu it opens - so the row stays one line and options appearing or
  disappearing never reflow the composer.
- **Mid-turn switching allowed**, applying from the next turn.
- Wire the ACP `SessionConfigOption` type through to the snapshot as-is rather than defining a
  parallel shape that can drift.
- Advertise `session: { configOptions: { boolean: {} } }` in `initialize` so Fast mode arrives as a
  native boolean instead of an on/off select.
- Render nothing at all when `configOptions` is absent or empty (poll mode, minimal ACP servers).
- **Every switch is recorded in the thread, and a run of them is not collapsed.** Collapsing was the
  first instinct and it is wrong here: the log is append-only and stamped in real time, which is what
  makes it the record, and rewriting the last entry to tidy the display would trade that property for
  the tidying. The de-duplication the agent-restart note gets is there because a dev daemon restarts
  on every file save - a machine repeating itself, not a person changing their mind.
- **Only what actually took is remembered.** A `set_config_option` can succeed without the value
  moving (a `PreModelSwitch` hook declining it), so the answer's `currentValue` is checked before the
  pick is persisted or written to the thread. Otherwise a refused value would be re-offered to every
  later session, and the thread would carry a switch that never happened.
- **Options the agent moved on its own are reported, never pinned.** Pinning them would carry a
  change nobody asked for into every later session - most sharply the permission-mode downgrade a
  model without Auto-mode support causes, which would outlive the model that caused it.
- Ordered by `category` (model, thought_level, mode, model_config, then anything uncategorised in the
  agent's own order), not in the agent's order, which leads with the mode and would open the menu on
  something other than the choice the button is named after. Placement is what the spec says the
  field is for.

---

## 2. Session restore

### The conversation half: supported

`claude-agent-acp` advertises:

```js
loadSession: true
sessionCapabilities: { list:{}, delete:{}, fork:{}, resume:{}, close:{}, additionalDirectories:{}, subagents:{} }
```

- **`session/list`** `{ cwd }` -> `{ sessions: [{ sessionId, cwd, title, updatedAt }] }`. `title` is
  the transcript summary. This is the picker's data source. Note it lists *every* Claude Code
  session for that directory, including ones the user ran in a terminal, not only eztweak's.
- **`session/load`** -> restores context **and replays the whole history back as `session/update`
  notifications**, then sends `available_commands_update`.
- **`session/resume`** -> restores context without replaying. Cheaper, and the right call here.
- **`session/fork`** -> the adapter supports `_meta.jetbrains.air.fork = { version: 1, messageId,
  messageFingerprint?, messageOccurrence? }` and forks **up to that message**, i.e. a
  non-destructive rewind to a point in the conversation. `messageId` is the first-class ACP field
  `messageId` on `agent_message_chunk` / `user_message_chunk` / `agent_thought_chunk`, so eztweak
  only has to record it while streaming. Without the `_meta`, fork means "fork at latest".

`codex-acp` reports `loadSession: false` and `sessionCapabilities: {}`. This whole feature needs
gating in the same shape as the existing `canClose`.

**Do not rebuild the thread from the replay.** eztweak's prompts are the `acpPrompt()` poll JSON, so
`session/load`'s replayed `user_message_chunk`s are that JSON. The thread should stay sourced from
eztweak's own `conversation.json`, keyed to the ACP session it belongs to. That means replacing the
single `conversationClear: { at }` in `session.json` with a list of chat epochs
(`{ acpSessionId, startedAt }`), so "restore that conversation" is: pick an epoch, `session/resume`
its `acpSessionId`, move the thread window to it. `session/resume` over `session/load` follows from
this - the replay would be discarded anyway.

**Side benefit worth taking on its own.** README currently promises that a daemon restart brings the
agent back in a fresh context, with `AGENT_RESTARTED_NOTE` posted into the thread to say so. Storing
`acpSessionId` in `PersistedSession` and restoring via `session/resume` removes that loss, and the
note with it.

### Measured behaviour

**`session/resume` survives a process restart**, which is the daemon-restart case exactly. Process 1
opened a session and told it to remember `8261`, then was killed with `SIGKILL`; a second process
resumed that `sessionId` and answered `8261`. It **replayed 0 updates**, so it is cheap and does not
put anything in the thread. It returns `configOptions`, and the resumed session came back on the
agent's default model - so a remembered model pick has to be re-asserted on the resume path too.

**Fork-at-message works and is non-destructive.** A session was told `111`, then `222`; forking with
`_meta.jetbrains.air.fork = { version: 1, messageId: <reply to the 111 turn> }` produced a session
that recalled `111` alone, while the original still recalled `111, 222`. The handle is the
`messageId` on `agent_message_chunk` - the Anthropic API message id (`msg_...`).

Both capabilities are advertised as `{}` by `claude-agent-acp` (`resume`, `fork`).

### The code-change half: not supported

ACP's schema has no `rewind`, `checkpoint`, `revert` or `undo` - and neither does the adapter.

Claude Code itself does, on its SDK control channel:

```
{ subtype: 'rewind_files', user_message_id, dry_run? }
  -> { canRewind, error?, filesChanged?, insertions?, deletions?, skippedLinks? }
     "Rewinds file changes made since a specific user message."
```

plus `rewind_conversation` and `get_workspace_diff`. `claude-agent-acp` does not bridge any of them
(its only custom methods are `_session/steering`, the async-task stop, and the goal extension), so an
ACP client cannot reach them. Bridging `rewind_files` as an ACP extension method is a reasonable
upstream ask.

So this has to be built here. Three mechanisms:

**(a) git checkpoints - recommended.** Before handing a batch to the agent, record a tree
(`git stash create`, or `add`+`write-tree` against a temp index) under
`refs/eztweak/<session>/<batchId>`. Restore with `git restore --source=<tree> -- <paths>`. Standard,
durable, and it covers files the agent changed by running a shell command. Requires a git repo, which
eztweak's project resolution (nearest `.git` *or* `package.json`) does not guarantee.

**(b) diff replay.** ACP's `ToolCallContent` has a `diff` variant carrying `path`, `oldText`
(optional) and `newText`. eztweak throws all tool content away today - `AcpFeedItem`'s `tool` keeps
only `title` and `status`. Wiring it up gives the README roadmap's "diff-derived Keep/Undo". But
`oldText` is optional and it only sees `Edit`/`Write`, never a file changed by a shell command. Not
sufficient alone.

**(c) `agentFileChangeReport` for scoping.** The adapter has an extension: a client that advertises
`air.agentFileChangeReport` gets a per-turn `{ paths, complete, uncertainty? }` self-report from the
agent. It does not supply content, but it does say which files to touch.

**(a) + (c)** is the strongest combination: content from the git tree, scope limited by the report,
so a file the user edited by hand in the meantime is not silently reverted.

### Decisions taken (not yet built)

The ask decomposes into three features whose cost and risk differ by an order of magnitude, and all
three are in scope:

- **R1 - resume across a daemon restart.** No UI. Store the `acpSessionId`, restore through
  `session/resume`. Removes the context loss the README currently promises, and the
  `AGENT_RESTARTED_NOTE` with it. A dev daemon restarts on every file save, so this is the one that
  changes day-to-day work on eztweak itself.
- **R2 - continue an earlier conversation.** A picker over eztweak's own chats. Touches no files.
- **R3 - rewind this review to before batch N, files included.** The only destructive one.

**R3's two halves are one action, not two.** An earlier draft of this document said to keep
"restore conversation" and "restore files" separate; that is wrong. Restoring files to before batch
N while leaving the agent's context after it means the agent's next turn reasons from a false
picture - it will skip work it believes it did, or "fix" what is already right. The mirror case is
the same defect. Either both or neither. R2 is unaffected: continuing an old conversation never
claimed to undo anything.

**R3 uses `/new`, not fork-at-message.** Fork preserves the context before N and is verified to
work, but it rests on two unstable things: `session/fork` is marked UNSTABLE in the spec ("may be
removed or changed at any point") and the fork point travels in `_meta.jetbrains.air.fork`, another
editor's vendor namespace inside the Claude adapter. Pinning the correctness of a destructive
feature to that is the wrong trade. With `/new` the agent's memory is *empty* rather than *wrong* -
and an empty memory does not lie - while the conversation before N stays in eztweak's own thread
where the user can still read it. The cost is the lost context; if that proves annoying, fork can be
added later behind a capability check, as an optimisation rather than the foundation.

**Files come back from a git checkpoint, one click, behind a file list.** Before each batch is
handed over: `GIT_INDEX_FILE=<tmp> git add -A`, `write-tree`, `commit-tree`, and a ref under
`refs/eztweak/<sessionKey>/<batchId>`. That includes untracked files, respects `.gitignore`, never
touches the working tree, and stays out of the user's own ref namespace; the session's refs are
pruned when it ends. `ToolCallContent.diff` carries `oldText` and could rebuild a file without git,
but it is optional and blind to anything a shell command wrote - an undo that silently misses a file
is worse than none - so a project that is not a git repo is refused outright rather than served a
best-effort. Scope comes from the agent's own per-turn `agentFileChangeReport`, supplemented by the
`diff` paths, intersected with the checkpoint's diff.

The confirmation is not politeness. A checkpoint captures the whole worktree, so it also holds the
user's own edits, and restoring it undoes anything they changed by hand after that point. Scoping to
the agent's reported paths covers most of it, but a file both parties touched is irreducibly
ambiguous - the file list is what makes that the user's call instead of ours.

**UI.** R3 hangs off each user bubble in the thread ("rewind to before this"), because which batch is
the action's only parameter and the bubble is where that lives; clicking it expands the file list and
the confirm. R2's list is eztweak's own chats only, drawn from `chats[]` - every one of those has a
thread to show, where a session the user ran in their terminal would open on an empty one.
`session/list` is still used, for two things: dropping chats the agent no longer has on disk, and
borrowing its `title` (the agent's own summary).

**Data model.** `PersistedSession` gains `chats: Chat[]` (`{ id, acpSessionId?, startedAt }`) and
`currentChatId`; `ConversationEntry` gains `chatId`. The thread window stops being "ts >= clear.at"
and becomes "chatId === currentChatId", because R2 breaks the time window: return to an earlier chat
and keep talking, and its new entries are stamped later than the chat that followed it. `chatId` is
also append-only, which the log requires. `conversationClear` stays readable for migration.

**Engineering risk, and it is not the protocol.** The SDK's `ActiveSession` wraps `session/new`
alone and `attachSession` is private, so resume and fork need their own update routing. The SDK's
`SessionUpdateRouter.handleMessage` returns `Handled.no`, so it does not consume the notification and
a client's own `onNotification(session/update)` handler can coexist; `ActiveSession.prompt` enqueues
the turn's `stop` in a `.then()` microtask into the same queue the notification handler fills
synchronously, and *that* is the whole ordering guarantee `pump`'s comment is about. Reproducing it
is roughly 40 lines. It should then be the only path, `session/new` included: resume becomes the
common case after R1, so it cannot be the second-class one, and two queue implementations would
drift - the divergent one announcing itself as an empty reply about one turn in ten. The existing
ordering test is the guard.

---

## 3. Skill list and per-session toggle

ACP has no concept of a skill. The two halves have very different difficulty.

### Disabling: a real, session-scoped mechanism exists

Claude Code resolves a `skillOverrides` settings map:

```js
var TIn = { on: 0, 'name-only': 1, 'user-invocable-only': 2, off: 3 }
// read from merged settings, then overlaid by ['policySettings', 'flagSettings']
// refused at invocation with: '"<name>" is disabled via skillOverrides.'
```

Settings merge low-to-high as
`['userSettings', 'projectSettings', 'localSettings', 'flagSettings', 'policySettings']`, and
`--settings` (inline JSON or a path) is what populates `flagSettings` - so it outranks everything
the user has on disk short of managed policy.

The way in: `claude-agent-acp` spreads `_meta.claudeCode.options` almost verbatim into the SDK query
options, including `settings`, `disallowedTools`, `extraArgs`, `hooks` and `env`. So

```
session/new  _meta.claudeCode.options.settings = { skillOverrides: { dataviz: 'off' } }
```

disables named skills for that session without touching a single file of the user's.
`extraArgs: { 'disable-slash-commands': '' }` is the all-or-nothing switch (the CLI's own help text
for that flag reads "Disable all skills").

The cost: query options are baked when the query is created, so changing a toggle means rebuilding
the session. `loadSession` and `resumeSession` both go through `getOrCreateSession(params)` and read
`params._meta`, so the sequence is: toggle -> `session/close` -> `session/resume` the same
`sessionId` with the new settings. Context is kept, the new overrides take effect. **This is why
skills depends on session restore** - the plumbing is the same.

Two internal mechanisms that look useful but are not reachable: the CLI's
`getSessionSkillAllowlist` / `setSessionSkillAllowlist` (in-process, driven only by the interactive
`/skills` UI) and the `apply_flag_settings` control request (would let flagSettings change at
runtime with no session rebuild, but is not bridged to ACP).

### Enumerating: no honest source

Only two candidates, both incomplete.

**`available_commands_update`.** Already on the wire and currently discarded. The SDK schema for its
entries is literally described as "Information about an available skill (invoked via /command
syntax)", with fields `name`, `description`, `argumentHint`, `aliases` - **no type or source field**.
So built-in commands, custom commands, MCP prompts and user-invocable skills all arrive
indistinguishable, and the adapter's `getAvailableSlashCommands` strips `_meta` on the way through.
Worse: a skill that is model-invoked only never appears at all.

**A disk scan** of `.claude/skills`, `~/.claude/skills`, `.agents/skills` and
`.claude/plugins/*/skills` (the layouts the adapter's own `resolveSkillPath` probes) gives real skill
identity and frontmatter, but cannot see bundled skills - `dataviz`, `artifact-design`,
`code-review` and the rest ship inside the CLI binary with nothing on disk.

There is no `claude skills list` subcommand to shell out to either; `/skill-doctor` is interactive.

Intersecting the two proves "this name is definitely a skill" but cannot classify the union. A panel
headed "skills enabled in this session" that lists `/help` next to `dataviz` is worse than no panel.

### Recommendation

Do not build the feature as specified yet. Either:

- narrow it to something true - a panel of "`/` commands available in this session", rendered
  straight from `availableCommands` without claiming to be a skill list, with only the global
  all-skills switch as a toggle; or
- wait for upstream. The right fix is a skills capability in ACP, or at minimum
  `claude-agent-acp` preserving `AvailableCommand._meta` with a source marker. Worth filing.

---

## Cross-cutting notes

1. **`AcpAgent.onUpdate`'s `default: return` is the shared entry point** for all three features.
2. **`SessionBuilder` only wraps `session/new`.** There is no builder for load/resume/fork, and
   `ClientContext.attachSession` is private, so session restore must issue
   `ctx.request(methods.agent.session.load, ...)` and route `session/update` itself. That walks
   straight into the hazard `pump`'s comment documents: reading updates and the prompt's `stop` off
   two independent microtask chains lets the response settle first and end the turn before the words
   it was made of arrive, which produced an empty reply about one turn in ten. The single ordered
   queue `ActiveSession` provides has to be rebuilt before that path is taken.
3. **Vendor surface.** The skills mechanism (`_meta.claudeCode.options`) and fork-at-message
   (`_meta.jetbrains.air.fork`) are both agent-specific. Model switching is the only one that is
   protocol-native. All three need capability gating, at very different granularities.
