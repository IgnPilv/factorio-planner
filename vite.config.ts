import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `base` is set for GitHub Pages (https://<user>.github.io/factorio-planner/).
export default defineConfig({
  plugins: [react()],
  base: process.env.GITHUB_PAGES ? '/factorio-planner/' : '/',
  test: { environment: 'node' },
});
