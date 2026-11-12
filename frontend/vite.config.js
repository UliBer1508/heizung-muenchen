import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Service Worker: Build-Kennung einsetzen, damit jede neue Version einen eigenen Cache bekommt
// und die alten Programmdateien gelöscht werden (public/sw.js, 12.11.2026).
const swVersion = () => ({
  name: 'sw-version',
  apply: 'build',
  closeBundle() {
    const f = path.resolve(__dirname, 'dist/sw.js');
    if (!fs.existsSync(f)) return;
    const id = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 8) || Date.now().toString(36);
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replaceAll('__BUILD__', id));
  },
});

export default defineConfig({
  plugins: [react(), swVersion()],
});
