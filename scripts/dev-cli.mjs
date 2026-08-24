import { runCli } from './dev-env.mjs'

/** `eztweak` pointed at the dev daemon instead of the real one. */
await runCli(process.argv.slice(2))
