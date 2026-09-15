import { PrismaClient } from '@prisma/client';
import { ReasonerOutputSchema, type ReasonerProvider, type ReasonerResult, type SanitizedCaseContext } from './types';
import { PROMPT_VERSION } from './prompt';
import { LLMBudgetTracker } from '../../evaluation/types';

const DEFAULT_TIMEOUT_MS = 15000;

export class ReasonerService {
  private prisma: PrismaClient;
  private provider: ReasonerProvider;
  private modelName: string;

  constructor(prisma: PrismaClient, provider: ReasonerProvider, modelName: string = process.env.AI_MODEL || 'mock-model') {
    this.prisma = prisma;
    this.provider = provider;
    this.modelName = modelName;
  }

  /**
   * Executes the AI reasoning flow with timeout and strict Zod validation.
   * Persists the resulting decision trace into the database.
   */
  async executeReasoning(context: SanitizedCaseContext, attemptId: string, tracker?: LLMBudgetTracker): Promise<ReasonerResult> {
    const startTime = Date.now();
    let rawOutput: unknown;
    
    try {
      // Execute with timeout
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('PROVIDER_TIMEOUT')), DEFAULT_TIMEOUT_MS)
      );

      rawOutput = await Promise.race([
        this.provider.reason(context, tracker),
        timeoutPromise
      ]);

      const latencyMs = Date.now() - startTime;

      // Validate strict structured output
      const parsed = ReasonerOutputSchema.safeParse(rawOutput);

      if (!parsed.success) {
        throw new Error(`SCHEMA_VALIDATION_FAILED: ${parsed.error.message}`);
      }

      const validOutput = parsed.data;

      // Persist the AI Decision trace
      await this.prisma.agentDecision.create({
        data: {
          caseId: context.caseId,
          step: 'DIAGNOSIS',
          inputContext: JSON.stringify(context),
          decision: JSON.stringify({
            diagnosisCode: validOutput.diagnosisCode,
            diagnosisSummary: validOutput.diagnosisSummary,
            diagnosisConfidence: validOutput.diagnosisConfidence,
            recommendedAction: validOutput.recommendedAction,
            alternativeActions: validOutput.alternativeActions,
            escalationRecommendation: validOutput.escalationRecommendation,
            promptVersion: PROMPT_VERSION,
            attemptId: attemptId
          }),
          rationale: validOutput.recommendationReason,
          confidence: validOutput.recommendationConfidence,
          modelUsed: this.modelName,
          durationMs: latencyMs
        }
      });

      return {
        success: true,
        data: validOutput,
        model: this.modelName,
        promptVersion: PROMPT_VERSION,
        latencyMs,
      };

    } catch (error: any) {
      const latencyMs = Date.now() - startTime;
      const errorMessage = error.message || 'UNKNOWN_ERROR';
      
      // Store the failure for audit observability, using deterministic failure structures
      try {
        await this.prisma.agentDecision.create({
          data: {
            caseId: context.caseId,
            step: 'DIAGNOSIS',
            inputContext: JSON.stringify(context),
            decision: JSON.stringify({
              error: errorMessage,
              attemptId: attemptId,
              promptVersion: PROMPT_VERSION,
              rawOutput: typeof rawOutput === 'object' ? JSON.stringify(rawOutput).substring(0, 500) : rawOutput
            }),
            rationale: `Reasoner failed: ${errorMessage}`,
            confidence: 0,
            modelUsed: this.modelName,
            durationMs: latencyMs
          }
        });
      } catch (persistenceError) {
        // Fallback if db write fails during error handling
        console.error('Failed to persist reasoner error trace:', persistenceError);
      }

      return {
        success: false,
        error: errorMessage,
        model: this.modelName,
        promptVersion: PROMPT_VERSION,
        latencyMs,
      };
    }
  }
}
