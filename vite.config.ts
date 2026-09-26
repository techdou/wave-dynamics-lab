import { defineConfig } from 'vitest/config';

// 同一份配置同时服务 vite（dev/build/preview）与 vitest（test）。
export default defineConfig({
  base: './',
  server: {
    port: 5173,
    host: '127.0.0.1',
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 1500,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
