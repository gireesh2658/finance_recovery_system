import { Request, Response, NextFunction } from 'express';

/**
 * Global error boundary middleware.
 *
 * Catches all unhandled errors and returns a consistent JSON response.
 * Must be registered AFTER all routes.
 *
 * Per backend-dev-guidelines: error handlers are registered last.
 */
export function errorBoundary(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  console.error(`[ErrorBoundary] ${err.message}`, {
    stack: err.stack,
    timestamp: new Date().toISOString(),
  });

  const statusCode = (err as unknown as Record<string, unknown>).statusCode as number || 500;
  const message = statusCode === 500 ? 'Internal server error' : err.message;

  res.status(statusCode).json({
    success: false,
    error: {
      message,
      ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
    },
  });
}
