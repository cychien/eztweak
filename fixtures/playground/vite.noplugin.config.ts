import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/** The same app without `eztweakSource()`, so annotations arrive with no
 *  `anchor.source` and the component / section / selector fallbacks are what
 *  the agent has to work from. Run with `npm run dev -- --no-plugin`. */
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
})
