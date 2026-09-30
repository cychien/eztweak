---
name: eztweak
description: A design harness for a web project (增強設計), and the way into an eztweak review session. Five steps - product, stack, design, components, make - that build UI which belongs to the product and its visual system rather than to a template. Use the harness only when the user explicitly asks for 增強設計 or the design harness, never for an ordinary UI request; use the review part when the user asks to review or annotate a running page.
metadata:
  version: 0.7.0
---

# eztweak

A design harness for a web project. It runs in Claude Code, Codex, Gemini CLI or any agent that
can read this file, and it needs no eztweak session, daemon or UI: the project is the evidence,
the browser tool is whatever the agent has, and the two files at the project root are the
configuration. When an eztweak review session *is* open, its daemon points each turn at the step's
file directly and this file is not on the path.

## The harness

| Step | File | Runs when | Produces |
| --- | --- | --- | --- |
| 1 product | [reference/product.md](reference/product.md) | no `PRODUCT.md` | `PRODUCT.md` |
| 2 stack | [reference/stack.md](reference/stack.md) | `.eztweak/config.json` is missing, stale, or names no browser tool | `.eztweak/config.json`: the stack, the design system and component library in use, the browser tool |
| 3 design | [reference/design.md](reference/design.md) | no `DESIGN.md` | `DESIGN.md`: the visual language in broad strokes, a direction rather than a spec, no components |
| 4 components | [reference/components.md](reference/components.md) | `.eztweak/config.json` records no `components.primitives` | `DESIGN.md`'s language made concrete in the design system, and the component set written in the project's own library |
| 5 make | [reference/make.md](reference/make.md) | a request to change or build UI, or an explore round asking for variants | the change, or the variants |

Steps 1 to 4 configure the project; 5 is the work, and it ends by having an independent reviewer
judge what it made ([reference/critique.md](reference/critique.md)) and letting `PRODUCT.md`,
`DESIGN.md` and this user's taste, `.eztweak/taste.md` - which the work is built to and judged by -
learn from the request. Each
step reads what the ones before it produced, and a step never rewrites another step's file. A step
whose file is not there yet says so in one line and is skipped.

## When the harness applies

Only in a turn that explicitly turns it on, never by default. Inside an eztweak review session,
that is a prompt saying `增強設計 (the design harness) is on for this turn.` Outside a session, it
is a request in which the user asks for 增強設計 or the design harness by name.

Any other turn is handled as if this skill had never been read, even later in a conversation where
the harness was on: no harness steps, no designing by `PRODUCT.md` or `DESIGN.md`, no review by
its rules, and no edits to `PRODUCT.md`, `DESIGN.md` or `.eztweak/config.json` unless the request
asks for one.

When it applies, talk to the user in the language they write in and in their words - 增強設計,
設計規範, 靈感 - never the harness's own: harness, step or file names, precedent, inspire, or the
review and its scores, which are the agent's business and not theirs.

- **Both files exist: in the harness.** Read `PRODUCT.md` and `DESIGN.md` before any visual change.
  Keep to `PRODUCT.md`; take `DESIGN.md` as a direction to start from, not a rule to obey. An
  ordinary change edits code only; the two
  files change only as step 5 says. Run step 5 for the request. When `.eztweak/config.json` is
  missing or stale, run step 2 first; when it records no `components.primitives`, run step 4
  first.
- **Either is missing: ask before anything else**, because the harness cannot run without it. Ask
  the user, word for word, naming only the file that is missing when one exists:

  > 啟用增強設計：增強設計會建立 PRODUCT.md 與 DESIGN.md，是否繼續？

  with two options in this order: 「繼續」 and 「取消」. Use your question tool if you have
  one; otherwise ask in your reply and end the turn.
  - **Yes:** walk steps 1 to 4 in order, starting at the first one whose output is missing, then
    do the work through step 5.
  - **No:** the harness cannot be used. Do the work as you would without this skill.

## Opening an eztweak review

When the user wants to annotate a running page in the browser and have the feedback come back as
exact source locations, open a review session: [reference/start.md](reference/start.md). This is
the one part of the skill that needs eztweak installed.

## Inside a review session

The daemon has done the routing: its prompt says whether the turn is a feedback batch or an
explore round, and names the file to read. Do not route again. A batch adds what a bare request
cannot: the page's `url`, the annotated `items` with their `anchor` (source `file:line`, selector,
viewport), `references`, and `attachments`. An explore adds one element's capture - its markup,
computed styles, slot and the page's tokens - and takes each variant back through a tool, editing
no file. The making step says where each of those is used.
