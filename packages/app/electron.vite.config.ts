import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';

/** The production CSP has no inline scripts; the dev server needs them for React refresh and HMR. */
const devCsp = (): Plugin => ({
  name: 'flowdeck-dev-csp',
  apply: 'serve',
  transformIndexHtml: (html) =>
    html
      .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
      .replace("connect-src 'self'", "connect-src 'self' ws://localhost:*"),
});

// Only `dependencies` (native modules) stay external; workspace and other libs are bundled.
export default defineConfig({
  main: {
    build: {
      rollupOptions: { input: resolve(__dirname, 'src/main/index.ts') },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/preload/index.ts'),
        // Sandboxed preloads must be CommonJS.
        output: { format: 'cjs', entryFileNames: '[name].js' },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react(), devCsp()],
    build: {
      rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') },
    },
  },
});
