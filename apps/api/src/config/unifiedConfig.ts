import dotenv from 'dotenv';

dotenv.config();

/**
 * Centralized, type-safe configuration.
 *
 * All environment variables are accessed exclusively through this module.
 * Direct `process.env` usage anywhere else is prohibited per backend-dev-guidelines.
 */
export const config = {
  env: process.env.NODE_ENV || 'development',
  isDev: process.env.NODE_ENV !== 'production',

  server: {
    port: parseInt(process.env.PORT || '4000', 10),
    apiPrefix: process.env.API_PREFIX || '/api',
  },

  database: {
    url: process.env.DATABASE_URL || 'file:./dev.db',
  },

  cors: {
    origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
  },

  llm: {
    provider: process.env.LLM_PROVIDER || '',
    apiKey: process.env.LLM_API_KEY || '',
    model: process.env.LLM_MODEL || '',
  },
} as const;
