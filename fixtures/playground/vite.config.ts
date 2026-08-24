import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { eztweakSource } from '../../src/vite.js'

export default defineConfig({
  plugins: [eztweakSource(), react()],
  server: { port: 5173 },
})
