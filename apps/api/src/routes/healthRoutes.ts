import { Router } from 'express';
import { HealthController } from '../controllers';

/**
 * Health check routes.
 *
 * Per backend-dev-guidelines: routes only route — no business logic here.
 * All handler logic is delegated to the controller.
 */
const healthController = new HealthController();
const router = Router();

router.get('/health', (req, res) => healthController.check(req, res));

export { router as healthRoutes };
