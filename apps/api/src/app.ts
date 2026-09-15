import express from 'express';
import cors from 'cors';
import { config } from './config';
import { healthRoutes } from './routes';
import { errorBoundary } from './middleware';

/**
 * Express application setup.
 *
 * Middleware execution order (per backend-dev-guidelines):
 * 1. Body parsing
 * 2. CORS
 * 3. Routes
 * 4. Error boundary (LAST)
 */
const app = express();

// ── Body Parsing ──
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── CORS ──
app.use(cors({
  origin: config.cors.origin,
  credentials: true,
}));

// ── Routes ──
app.use(config.server.apiPrefix, healthRoutes);

// ── Error Boundary (must be registered AFTER routes) ──
app.use(errorBoundary);

export { app };
