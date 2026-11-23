import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// The Pinna app (Vue SPA). The build goes to dist/, served by the Worker.
export default defineConfig({
  plugins: [vue()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
