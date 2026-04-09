import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  server: {
    // Dev mode: proxy /api to UIServer
    proxy: {
      '/api': 'http://127.0.0.1:18788',
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        wiki: resolve(__dirname, 'wiki.html'),
        plugins: resolve(__dirname, 'plugins.html'),
      },
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom'],
          'vendor-markdown': ['react-markdown', 'remark-gfm', 'rehype-highlight', 'highlight.js'],
        },
      },
    },
  },
});
