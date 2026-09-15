import { Request, Response } from 'express';
import { BaseController } from './BaseController';

/**
 * Health check controller.
 *
 * Provides basic liveness and readiness probes for the API server.
 */
export class HealthController extends BaseController {
  async check(_req: Request, res: Response): Promise<void> {
    try {
      this.handleSuccess(res, {
        status: 'healthy',
        service: 'ai-revenue-recovery-agent',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        environment: process.env.NODE_ENV || 'development',
      }, 'Server is running');
    } catch (error) {
      this.handleError(error, res, 'check');
    }
  }
}
