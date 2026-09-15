import { OpenAI } from 'openai';
import type { ReasonerProvider, SanitizedCaseContext, ProviderProbeResult } from './types';
import { SYSTEM_PROMPT } from './prompt';
import type { LLMBudgetTracker } from '../../evaluation/types';

/**
 * OpenRouter provider — OpenAI-compatible API with custom baseURL.
 * 
 * Configuration (environment variables only):
 *   OPENROUTER_API_KEY   — required, never logged
 *   OPENROUTER_MODEL     — required (e.g. "zhipu/glm-z1-9b:free")
 *   OPENROUTER_BASE_URL  — optional, defaults to https://openrouter.ai/api/v1
 *   AI_TIMEOUT_MS        — optional, defaults to 30000
 * 
 * Security invariants:
 *   - API key is read ONLY from process.env.OPENROUTER_API_KEY
 *   - API key is NEVER logged, printed, or included in error messages
 *   - API key is NEVER committed to source control
 */

export class OpenRouterReasonerProvider implements ReasonerProvider {
  private client: OpenAI;
  private model: string;
  private timeoutMs: number;

  constructor() {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new Error('CONFIGURATION_ERROR: OPENROUTER_API_KEY is missing');
    }

    const model = process.env.OPENROUTER_MODEL;
    if (!model) {
      throw new Error('CONFIGURATION_ERROR: OPENROUTER_MODEL is missing');
    }

    const baseURL = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';

    const timeoutMs = parseInt(process.env.AI_TIMEOUT_MS || '30000', 10);
    if (isNaN(timeoutMs) || timeoutMs <= 0) {
      throw new Error('CONFIGURATION_ERROR: AI_TIMEOUT_MS must be a positive integer');
    }

    this.model = model;
    this.timeoutMs = timeoutMs;

    // OpenRouter is OpenAI-compatible — reuse the SDK with custom baseURL
    this.client = new OpenAI({
      apiKey,
      baseURL,
      timeout: this.timeoutMs,
      defaultHeaders: {
        'HTTP-Referer': 'https://razorpay-recovery.local',
        'X-Title': 'RazorPay Recovery Agent',
      },
    });
  }

  async reason(context: SanitizedCaseContext, tracker?: LLMBudgetTracker): Promise<unknown> {
    const maxAttempts = 2; // 1 initial + 1 bounded retry
    let lastProviderError: string | undefined;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const kind = attempt === 0 ? 'INITIAL' as const : 'RETRY' as const;

      // Atomic budget reservation
      if (tracker) {
        const reservation = tracker.tryConsumeRequest(context.caseId, kind);
        if (!reservation.allowed) {
          if (lastProviderError) {
            // Preserve the original provider error
            throw new Error(lastProviderError);
          }
          throw new Error(`BUDGET_EXHAUSTED_BEFORE_REQUEST: ${reservation.blockReason}`);
        }
      }

      // Budget consumed — make the actual HTTP request
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await this.client.chat.completions.create({
          model: this.model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: JSON.stringify(context, null, 2) }
          ],
          temperature: 0.1,
          response_format: { type: 'json_object' }
        }, {
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        const messageContent = response.choices[0]?.message?.content;
        
        if (!messageContent) {
          throw new Error('PROVIDER_MALFORMED_OUTPUT: No content returned');
        }

        return JSON.parse(messageContent);
        
      } catch (error: any) {
        clearTimeout(timeoutId);
        const normalizedError = this.normalizeError(error);
        
        // Non-retryable errors: throw immediately
        if (!this.isRetryable(normalizedError)) {
          throw new Error(normalizedError);
        }
        
        lastProviderError = normalizedError;
        // Continue to next iteration
      }
    }

    throw new Error(lastProviderError!);
  }

  async probe(): Promise<ProviderProbeResult> {
    try {
      await this.client.chat.completions.create({
        model: this.model,
        messages: [{ role: 'user', content: 'probe' }],
        max_tokens: 5,
      }, {
        timeout: this.timeoutMs,
      });

      return { status: 'AVAILABLE' };
    } catch (error: any) {
      const normalizedError = this.normalizeError(error);
      
      if (normalizedError.includes('PROVIDER_AUTH_FAILURE')) {
        return { status: 'AUTHENTICATION_FAILURE', error: normalizedError };
      }
      if (normalizedError.includes('RATE_LIMIT')) {
        return { status: 'RATE_LIMIT_OR_QUOTA_EXHAUSTED', error: normalizedError };
      }
      if (normalizedError.includes('NETWORK_FAILURE') || normalizedError.includes('UNAVAILABLE')) {
        return { status: 'NETWORK_FAILURE', error: normalizedError };
      }
      if (normalizedError.includes('PROVIDER_TIMEOUT')) {
        return { status: 'TIMEOUT', error: normalizedError };
      }
      return { status: 'UNKNOWN_PROVIDER_FAILURE', error: normalizedError };
    }
  }

  private isRetryable(normalizedError: string): boolean {
    return normalizedError.includes('TRANSIENT') || normalizedError.includes('RATE_LIMIT');
  }

  private normalizeError(error: any): string {
    // Never include API key in error output — sanitize defensively
    if (error.name === 'AbortError' || error.message?.includes('AbortError') || error.message?.includes('operation was aborted')) {
      return 'PROVIDER_TIMEOUT';
    }
    
    if (error instanceof OpenAI.APIConnectionTimeoutError) {
      return 'PROVIDER_TIMEOUT';
    }
    if (error instanceof OpenAI.AuthenticationError || error.status === 401 || error.status === 403) {
      return 'PROVIDER_AUTH_FAILURE: Authentication failed';
    }
    if (error instanceof OpenAI.RateLimitError || error.status === 429 || error.status === 402) {
      return 'PROVIDER_RATE_LIMIT_TRANSIENT: Rate limit exceeded or quota exhausted';
    }
    if (error instanceof OpenAI.APIConnectionError || error instanceof OpenAI.InternalServerError || error.status >= 500) {
      return 'PROVIDER_UNAVAILABLE_TRANSIENT: API server error';
    }
    if (error.code === 'ECONNRESET' || error.code === 'ENOTFOUND' || error.message?.includes('fetch failed')) {
      return 'PROVIDER_NETWORK_FAILURE_TRANSIENT';
    }
    if (error instanceof SyntaxError || (error.message && error.message.includes('Unexpected token'))) {
      return 'PROVIDER_MALFORMED_OUTPUT: Invalid JSON structure';
    }
    
    // Sanitize: strip any potential secret from error messages
    const safeMessage = (error.message || 'Unknown provider error').replace(/sk-or-[^\s"']+/g, '[REDACTED]');
    return `PROVIDER_UNKNOWN_ERROR: ${safeMessage}`;
  }
}
