import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const rootDir = import.meta.dirname;

export default defineConfig({
  root: resolve(rootDir),
  base: '/admin/',
  plugins: [react()],
  resolve: {
    // 後台是獨立的 vite build，不吃根 tsconfig 的 paths。共用套件要在這裡對應到
    // 原始碼，否則只有型別解析得到，實際 bundle 會找不到模組。
    alias: { '@storeweave/i18n': resolve(rootDir, '../../packages/platform/i18n/src/index.ts') },
  },
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
