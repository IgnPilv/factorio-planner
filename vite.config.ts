import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// BASE_PATH is set by the Pages workflows: /factorio-planner/ for the live site,
// /factorio-planner/pr-preview/pr-N/ for pull request previews.
export default defineConfig({
  plugins: [react()],
  base: process.env.BASE_PATH ?? '/',
  test: { environment: 'node' },
});
