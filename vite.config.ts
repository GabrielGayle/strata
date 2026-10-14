import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 2000,
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
} as any);
