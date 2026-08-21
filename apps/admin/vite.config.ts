import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const rootDir = import.meta.dirname;

export default defineConfig({
  root: resolve(rootDir),
  base: '/admin/',
  plugins: [react()],
  build: {
    outDir: resolve(rootDir, 'dist'),
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/health': 'http://localhost:3000',
    },
  },
});
