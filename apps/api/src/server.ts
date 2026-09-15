import { app } from './app';
import { config } from './config';

/**
 * HTTP server entry point.
 *
 * Separated from app.ts for testability (per backend-dev-guidelines).
 */
const PORT = config.server.port;

app.listen(PORT, () => {
  console.log(`
  ┌────────────────────────────────────────────┐
  │  AI Revenue Recovery Agent — API Server    │
  ├────────────────────────────────────────────┤
  │  Status:      Running                      │
  │  Port:        ${String(PORT).padEnd(29)}│
  │  Environment: ${config.env.padEnd(29)}│
  │  API Prefix:  ${config.server.apiPrefix.padEnd(29)}│
  │  Health:      http://localhost:${PORT}${config.server.apiPrefix}/health │
  └────────────────────────────────────────────┘
  `);
});
