// EthioLink admin — entry point.
//
// Mounts the app under #root with the four cross-cutting providers:
//
//   * `StrictMode`              — surface accidental side effects in dev.
//   * `QueryClientProvider`     — TanStack Query cache + dedupe across pages.
//   * `BrowserRouter`           — `history` API routing; the admin app
//                                 ships behind a single domain so the
//                                 default base of `/` is correct.
//   * `App`                     — the routes themselves.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';

import { App } from './App';

const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            // Admin reads are bounded and small; 30s stale window keeps
            // cross-page navigations snappy without going stale enough
            // to surface mid-edit conflicts.
            staleTime: 30_000,
            refetchOnWindowFocus: false,
            retry: 1,
        },
    },
});

const rootElement = document.getElementById('root');
if (!rootElement) {
    throw new Error('Missing #root element in index.html.');
}

createRoot(rootElement).render(
    <StrictMode>
        <QueryClientProvider client={queryClient}>
            <BrowserRouter>
                <App />
            </BrowserRouter>
        </QueryClientProvider>
    </StrictMode>,
);
