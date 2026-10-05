import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// El panel lo sirve el proceso api en /panel (mismo origen que /admin).
export default defineConfig({
  base: '/panel/',
  plugins: [react()],
  server: { proxy: { '/admin': 'http://localhost:3000' } },
});
