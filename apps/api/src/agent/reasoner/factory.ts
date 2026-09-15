import type { ReasonerProvider } from './types';
import { OpenRouterReasonerProvider } from './openrouter-provider';
import { BaselineEvaluationProvider } from '../../evaluation/baseline-provider';

export function getReasonerProvider(providerType: string): ReasonerProvider {
  const normalizedType = providerType.toUpperCase();

  switch (normalizedType) {
    case 'OPENROUTER':
      return new OpenRouterReasonerProvider();
    case 'BASELINE':
      return new BaselineEvaluationProvider();
    default:
      throw new Error(`UNKNOWN_PROVIDER: Provider "${providerType}" is not supported. Supported: OPENROUTER, BASELINE`);
  }
}
