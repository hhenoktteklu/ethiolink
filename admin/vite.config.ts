// EthioLink admin — Vite config.
//
// Single-page React + TypeScript app. Source under `src/`, env vars
// exposed under the `VITE_` prefix (see `src/lib/auth.ts` and
// `src/lib/api.ts` for the four required values: VITE_COGNITO_DOMAIN,
// VITE_COGNITO_ADMIN_CLIENT_ID, VITE_ADMIN_REDIRECT_URI,
// VITE_API_BASE_URL).

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
    plugins: [react()],
    server: {
        port: 5173,
    },
    build: {
        outDir: 'dist',
        sourcemap: true,
    },
});
