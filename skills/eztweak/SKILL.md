---
name: eztweak
description: Start an ACP-managed visual review loop on a live dev app. The user annotates the real page in the browser, and a spawned coding agent receives exact source locations, edits the code, and reports progress in the review shell. Use after generating or modifying UI the user should visually review, or when the user asks to review or annotate a running page.
metadata:
  version: 0.6.2
---

# eztweak - live-app ACP review

eztweak turns a locally running dev server into an annotatable review surface. Start the session
with an ACP agent, then let that agent own the feedback loop. It receives each annotation batch,
edits the source, and streams its work, questions, permission prompts, and replies into the review
shell while the app's HMR updates the page in place.

You do not need eztweak installed globally. Invoke it as `npx -y eztweak@latest ...`.

## When to use

- You just generated or significantly changed a page or component and the user should review it visually
- The user wants to give feedback by pointing at things instead of describing them in chat
- You are iterating on visual, copy, or layout details where prose descriptions are lossy

## Agent profile

Use the ACP profile matching the current coding-agent environment unless the user explicitly names
another ACP agent or command:

- Claude Code: `claude`
- Codex: `codex`
- Gemini CLI: `gemini`

Every skill invocation uses ACP mode. Never omit `--agent`, never run `eztweak poll`, and never fall
back to Poll mode after an ACP failure. If the environment does not identify a supported profile and
the user did not provide an ACP command, ask them which ACP agent to use.

## Workflow

1. Make sure the dev server is running. Never start a second instance when one is already up.
2. From the project root, run:

   ```sh
   npx -y eztweak@latest <url> --agent <profile>
   ```

   Use the full URL of the page to review, for example:

   ```sh
   npx -y eztweak@latest http://localhost:5173/pricing --agent codex
   ```

   The working directory matters because the session and spawned agent are scoped to that project.
   If the CLI says the user previously ended the session, do not pass `--reopen` unless the user
   explicitly asked to review again.
3. Once the CLI reports the session and agent, tell the user the review shell is ready. Do not start
   a parallel feedback loop or shadow the ACP agent's edits. The daemon delivers queued and future
   batches automatically, one turn at a time. The shell owns the turn: the user can stop one that is
   heading the wrong way (the Stop button, or Cmd/Ctrl+.), `/new` in the note box clears the agent's
   context and carries the review on in a fresh session, and a batch sent mid-turn queues rather
   than interrupting - so do not tell the user to wait for a turn to finish before annotating.
4. The user ends the review from the shell. Do not end or stop a live session unless they ask.

## Failures and switching agents

- If the ACP command is missing, unauthenticated, or exits, report that error and help fix that ACP
  setup. Do not substitute Poll mode.
- A live session can own only one ACP agent. If the CLI refuses a different agent, do not stop the
  daemon automatically because it may hold other sessions. Ask the user whether to end the current
  session or stop the daemon before switching.
- Do not retry a failing launch indefinitely. After one retry for a transient failure, report the
  blocker and preserve the session state.

## Source anchors

Projects using Vite get exact `file:line` anchors by adding the bundled plugin:

```ts
// vite.config.ts
import { eztweakSource } from 'eztweak/vite'
// plugins: [eztweakSource(), ...]
```

Suggest this dev-only plugin when feedback repeatedly arrives without exact source locations. It has
no production-build impact.

## Commands

- `npx -y eztweak@latest <url> --agent <profile-or-command> [--reopen]` - open or resume an ACP-managed review
- `npx -y eztweak@latest status` - inspect local daemon sessions
- `npx -y eztweak@latest stop` - stop the local daemon only when the user explicitly asks
