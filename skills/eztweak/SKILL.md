---
name: eztweak
description: Run a visual review loop on a live dev app - the user annotates elements and text directly in the browser, feedback flows back with exact source locations, the agent edits the code, HMR updates the page, repeat. Use after generating or modifying UI the user should visually review, or when the user asks to review/annotate a running page.
argument-hint: <dev server url to review>
---

# eztweak — live-app review loop

eztweak turns a locally running dev server into an annotatable review surface. You (the agent)
open a session, the user marks up the real page in their browser, and `eztweak poll` delivers
their feedback as structured items that resolve to source locations. You edit the source, the
app's own HMR updates the page in place, you reply, and the loop continues.

You do not need eztweak installed globally — invoke it as `npx -y eztweak@latest ...`.

## When to use

- You just generated or significantly changed a page/component and the user should review it visually
- The user wants to give feedback by pointing at things instead of describing them in chat
- Iterating on visual/copy/layout details where prose descriptions are lossy

## Workflow

1. Make sure the dev server is running (e.g. `pnpm dev`). Never start a second instance if one is already up.
   Run every `eztweak` command from the project's root - the session is scoped to that project, so
   a different working directory starts a separate review of the same url.
2. Run `npx -y eztweak@latest <url>` with the full URL of the page to review
   (e.g. `npx -y eztweak@latest http://localhost:5173/pricing`). This opens the review shell in the
   user's browser. If it refuses because the user previously ended the session, do not pass
   `--reopen` unless the user explicitly asked to review again.
3. Run `npx -y eztweak@latest poll <url>` and wait. It blocks silently until the user sends feedback —
   leave it running in the foreground, never kill it. If it dies or times out anyway, just re-run
   it; queued feedback is never lost.
   On the first poll after opening, prefer `--agent-reply "<one line: what you built and what to look at>"`
   so the conversation panel opens with context.
4. `poll` prints one JSON document then exits:
   - `{"type":"feedback", "items":[...], "note":...}` — act on it (see below), then poll again.
   - `{"type":"session-ended"}` — the user is done. Stop polling. Do not reopen uninvited.
     Deliver any remaining updates in the conversation instead.
5. For each feedback item:
   - `label` is a one-line summary; `anchor.source` (when present) is the exact `file:line` to
     edit — trust it over guessing. Otherwise use `anchor.components` (React component chain),
     `anchor.section` (`data-section` value), `anchor.selector`, and `anchor.text` to locate the code.
   - `kind` says how they pointed: `element` (framed a whole element), `text` (selected a run of
     text — `anchor.text` is that exact selection), or `point` (dropped a pin; the anchor already
     resolves to the deepest element under it, and `anchor.point.rel` gives the position *inside*
     that element as 0–1 fractions, which disambiguates a pin on a wide container).
   - `anchor.viewport` tells you which viewport the user was looking at — a `mobile` annotation
     is usually a responsive issue; fix it at that breakpoint, don't break desktop.
   - `attachments` (when present) are files the user pasted or dropped into that item's box, each
     `{name, mime, size, path}`. `path` is an absolute local file — **read it before you edit**.
     A pasted screenshot is usually the user showing you what they mean, and is often more
     specific than the sentence next to it. `[file n]` in the `comment` (and in `label`) is
     `attachments[n-1]`, so where the marker sits is the user telling you which file that part of
     the sentence is about. The batch itself can carry `attachments` too: those came with the note
     and apply to the whole round.
   - `references` (when present) are *other* elements the comment points at — "make this match that
     one". Each is `{n, anchor, label}` with the same layered anchor as an item, so `anchor.source` is
     a `file:line` you can open. `[ref n]` in the `comment` (and in `label`) names the reference whose
     `n` field equals that number - it is **not** an index into the array, so match on `n` and never
     on position. `n` is assigned when the user picked the element and is stable for the life of the
     comment, so gaps are normal: deleting one reference does not renumber the rest, and a lone
     `[ref 2]` with a single-entry `references` array is the expected shape, not a bug. Where the
     marker sits in the sentence is the user telling you which side of the comparison is which. A
     reference's `anchor.page` may differ from the item's — they are allowed to point across pages.
     The batch can carry `references` too, attached to the note rather than any one item.
     A reference with `anchor.contains` is a *region*: the user framed a box instead of pointing at
     one element. Its own anchor resolves to the common ancestor of what the box enclosed,
     `anchor.contains` is one line per enclosed element (`<Component> · file:line · "own text"` -
     the text snippet is what tells two instances of the same component apart, e.g. which two of
     three pricing cards), and `anchor.rect` is the box they drew. Act on the elements listed, not
     on the ancestor as a whole. You *may* open `url` + `anchor.page` at `anchor.viewport`'s size
     and look at the `anchor.rect` area yourself - but only when the page does not depend on the
     user's session: your browser is not logged in, and behind a login the layout shifts and that
     rect crops the wrong thing. When in doubt, trust `contains` and the text snippets over pixels.
   - Apply every item in the batch in one pass. HMR shows your edits live; don't restart the dev server.
   - While you work, the shell shows the user a "working" indicator. If the batch takes more than a
     few edits, narrate it: run `npx -y eztweak@latest progress <url> "<one short line: what you are
     doing right now>"` between steps (e.g. before starting item 2 of 5). Each call replaces the
     previous line - it is a status, not a log - so send the current step, not a summary so far.
     Do not send progress for a batch you will finish in one or two quick edits.
6. After applying a batch, run `npx -y eztweak@latest poll <url> --agent-reply "<what you changed, item by item, one short line each>"`
   to report back in the browser and wait for the next round. The reply clears the progress line.
7. When the user says they're satisfied (in chat or via the session), run `npx -y eztweak@latest end <url>`.

## Rules

- The poll stays silent until the user acts. Never treat silence as an error; never kill the poll.
- Background the poll only through a harness-native tracked facility that is guaranteed to notify
  you on completion. Never use `nohup`, shell `&`, or detached processes to keep it alive.
- Feedback items are the user's explicit requests — apply all of them. If an item conflicts with
  something important, apply the rest, then explain the conflict in `--agent-reply`.
- When you author pages that will be reviewed this way, give every top-level section a stable
  `data-section="<name>"` attribute — it is the anchor layer that survives refactors.
- Projects using Vite get exact `file:line` anchors by adding the bundled plugin:
  ```ts
  // vite.config.ts
  import { eztweakSource } from 'eztweak/vite'
  // plugins: [eztweakSource(), ...]
  ```
  Suggest this (dev-only, zero production impact) when anchors keep arriving without `source`.

## Commands

- `npx -y eztweak@latest <url> [--reopen]` — open or resume the review session for a dev server
- `npx -y eztweak@latest poll <url> [--agent-reply "<msg>"]` — deliver a reply, then block for feedback
- `npx -y eztweak@latest progress <url> "<msg>"` — update the working-on-it line while editing
- `npx -y eztweak@latest end <url>` — end the session as the agent (plain reopen stays allowed)
- `npx -y eztweak@latest status` / `stop` — inspect / stop the local daemon
