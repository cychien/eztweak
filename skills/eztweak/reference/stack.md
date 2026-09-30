# Define the project's stack and tools

> Only for a turn whose prompt says 增強設計 (the design harness) is on for it, or a request that
> asks for it by name. In any other turn, handle the request as if you had never read this file.

## What this file is

`.eztweak/config.json` at the project root records the architecture the application is built on,
the design system and component library it already uses, and where the tools used to work on it
come from. Later steps read it instead of rediscovering any of it: the stack and the component
library tell the components and making steps what code to write and in which style, and the tools
tell every step how to look at the running page.

The platform is web only, so the stack is a web stack.

```json
{
  "platform": "web",
  "stack": ["vite", "react", "typescript", "tailwind"],
  "design_system": { "kind": "tailwind", "path": "tailwind.config.ts" },
  "components": { "library": "shadcn", "path": "src/components/ui" },
  "tools": {
    "browser": {
      "name": "playwright",
      "via": "cli",
      "invoke": "npx playwright",
      "notes": "In the project's devDependencies; `npx playwright screenshot <url> out.png`."
    }
  }
}
```

- `platform` is always `"web"`.
- `stack` is a list of lower-case keywords, the names the ecosystem itself uses: `react`, `nextjs`,
  `vite`, `astro`, `sveltekit`, `vue`, `typescript`, `tailwind`, `css-modules`, `static-html`.
  Framework, language and styling approach at least.
- `design_system` is where the project's tokens live: `kind` is the idiom (`tailwind`,
  `css-variables`, `css-in-js`, or a component library's own theme such as `mui`) and `path` is the
  file an agent reads. `null` when the project has no tokens anywhere, only literal values.
- `components` is how the project writes components. `library` is the component library's name as
  its ecosystem spells it (`shadcn`, `mui`, `chakra`, `mantine`, `antd`, `headlessui`, `vuetify`),
  `custom` for the project's own components built on no library, or `none` when there is no
  component layer yet. `path` is where the components live, or will. `notes` is optional: a second
  library in use, a wrapper convention, anything the next step would otherwise trip over. The
  components step adds `primitives` here once it has built the set.
- `tools` is keyed by role. `browser` is the one this step fills; later steps add their own.
  Each tool says what it is (`name`), what kind of thing it is (`via`: `"skill"`, `"mcp"` or
  `"cli"`), and what an agent does to use it (`invoke`: the skill to load, the MCP server whose
  tools to call, or the command to run). `notes` is optional and holds what an agent would
  otherwise have to find out again: a flag, a prerequisite, a limit.
- A tool that was looked for and not found is recorded as `null`, so later steps know not to look
  again and can tell the user what to install.

## Step 1: Load current state

If there is no `PRODUCT.md`, run [product.md](product.md) first and come back: the stack of a
new project is inferred from what the product is.

Read `.eztweak/config.json` if it exists. Take its values as the record of an earlier pass, to be
checked against the project now, not as truth.

## Step 2: Define the architecture

### The project already has code

Read what it is built on: `package.json` dependencies and scripts, the framework's config file,
the lockfile, how styles are written, the language. Record the keywords.

Then read what it already designs with, because every component added later has to be written the
way these ones are:

- **The design system.** A Tailwind config or a CSS `@theme` block; `:root` custom properties; a
  CSS-in-JS theme; a component library's theme object. Record the one the project treats as the
  source, and `null` when the values are only literal.
- **The component library.** `components.json` at the root, or `@radix-ui/*` with
  `class-variance-authority` and a `components/ui` directory, is `shadcn`; a library in
  `package.json` (`@mui/material`, `@chakra-ui/react`, `@mantine/core`, `antd`,
  `@headlessui/react`, `vuetify`) is that library; a components directory built on none of them is
  `custom`. When two are in use, record the one most of the components are built on and name the
  other in `notes`. Never assume one from the framework: a React project is not a shadcn project
  until the files say so.

If the config already holds a stack, compare it with what you found. A keyword the project no
longer uses, or a framework it has moved off, makes the record legacy: replace it with the current
stack and say in one line what changed.

### The project is new

Recommend a stack from `PRODUCT.md`. A simple site with no data, accounts or growth to plan for is
served by the simplest architecture that renders it; a product with users, state and screens that
will multiply is served by a component framework. Match the weight of the stack to the product,
not to fashion.

When more than one stack fits, or `PRODUCT.md` cannot settle it, ask the user. They may not be
technical, so do the narrowing for them: at most three candidates, each in one line that says what
choosing it means for *their product* - how fast it ships, what it costs to host, what it can grow
into, what it locks them out of - in the user's own language, no framework jargon without a
plain-words gloss. Lead with the one you recommend and mark it as recommended. Use the structured
question tool when available; otherwise ask in your reply and wait.

The design system and the component library follow from the stack. A new React project uses
`shadcn` with Tailwind as its design system. Any other new project records `custom`, with its
tokens in the stack's own idiom, unless the user asks for a library by name.

Record the decision. Creating the project itself is the first making request, not this step.

## Step 3: Define the tool sources

**Browser tool.** Every later step looks at the rendered page, so find the tool this agent can
actually use to open a URL, take a screenshot and read computed styles. Look, in order, at: a skill
the agent has that drives a browser; an MCP server that does; a CLI the project or the machine has
installed (Playwright, Puppeteer, a headless Chrome). Prefer the one that needs no install. Record
it under `tools.browser`, with `invoke` precise enough that an agent that has never seen this
project can use it without a search, and put anything it would trip over in `notes`.

When nothing is found, record `"browser": null` and tell the user which tool to install; the
making and reviewing steps then work from source alone and say so.

## Step 4: Wrap up or resume

Write `.eztweak/config.json`, creating the directory if needed. Say something to the user only
when they have to act on it - no browser tool was found, and here is how to install one. The rest
of this step is the harness's own business. Then end, or resume the request that invoked this.
