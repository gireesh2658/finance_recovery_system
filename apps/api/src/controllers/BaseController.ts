import { Response } from 'express';

/**
 * Base controller providing consistent response handling.
 *
 * All controllers must extend this class.
 * Per backend-dev-guidelines: no raw res.json() calls outside BaseController helpers.
 */
export abstract class BaseController {
  /**
   * Send a success response.
   */
  protected handleSuccess<T>(
    res: Response,
    data: T,
    message = 'Success',
    statusCode = 200,
  ): void {
    res.status(statusCode).json({
      success: true,
      message,
      data,
    });
  }

  /**
   * Handle and send an error response.
   */
  protected handleError(
    error: unknown,
    res: Response,
    context: string,
  ): void {
    console.error(`[${this.constructor.name}.${context}]`, error);

    const err = error instanceof Error ? error : new Error(String(error));
    const statusCode = (err as unknown as Record<string, unknown>).statusCode as number || 500;
    const message = statusCode === 500 ? 'Internal server error' : err.message;

    res.status(statusCode).json({
      success: false,
      error: {
        message,
        context,
      },
    });
  }
}
