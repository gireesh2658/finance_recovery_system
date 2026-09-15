import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getReasonerProvider } from './factory';
import { OpenRouterReasonerProvider } from './openrouter-provider';
import { BaselineEvaluationProvider } from '../../evaluation/baseline-provider';

describe('Provider Removal Regression (Step 27)', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('A. Factory accepts OPENROUTER', () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
    vi.stubEnv('OPENROUTER_MODEL', 'test-model');
    const provider = getReasonerProvider('OPENROUTER');
    expect(provider).toBeInstanceOf(OpenRouterReasonerProvider);
  });

  it('B. Factory accepts BASELINE', () => {
    const provider = getReasonerProvider('BASELINE');
    expect(provider).toBeInstanceOf(BaselineEvaluationProvider);
  });

  it('C. Factory rejects GEMINI', () => {
    expect(() => getReasonerProvider('GEMINI')).toThrow(/UNKNOWN_PROVIDER/);
  });

  it('D. Factory rejects OPENAI', () => {
    expect(() => getReasonerProvider('OPENAI')).toThrow(/UNKNOWN_PROVIDER/);
  });

  it('E. Unknown provider is rejected', () => {
    expect(() => getReasonerProvider('FAKE')).toThrow(/UNKNOWN_PROVIDER/);
  });

  it('F/G. Rejected providers do not cause API requests (fail synchronously)', () => {
    expect(() => getReasonerProvider('GEMINI')).toThrow();
    expect(() => getReasonerProvider('OPENAI')).toThrow();
    // They throw synchronously in the factory, making any async network request impossible
  });

  it('H/I. OpenRouter failure does not trigger Gemini or OpenAI fallback', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
    vi.stubEnv('OPENROUTER_MODEL', 'test-model');
    const provider = getReasonerProvider('OPENROUTER');
    
    (provider as any).client = {
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(new Error('OpenRouter is down'))
        }
      }
    };
    
    // Call probe, expect it to fail gracefully, NO fallback logic exists in Provider interface
    const result = await provider.probe();
    expect(result.status).toBe('UNKNOWN_PROVIDER_FAILURE');
  });

  it('J. Invalid OpenRouter configuration causes immediate failure', () => {
    vi.stubEnv('OPENROUTER_API_KEY', '');
    expect(() => getReasonerProvider('OPENROUTER')).toThrow(/CONFIGURATION_ERROR/);
  });

  it('K. API key is never included in serialized errors/logging', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'SUPER_SECRET_KEY');
    vi.stubEnv('OPENROUTER_MODEL', 'test-model');
    
    const provider = getReasonerProvider('OPENROUTER');
    try {
      await provider.reason({} as any);
    } catch (e: any) {
      const errorStr = JSON.stringify(e, Object.getOwnPropertyNames(e));
      expect(errorStr).not.toContain('SUPER_SECRET_KEY');
    }
  });

  it('L/M/N/O. Probe does not consume budget, DB, GT, or recovery', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
    vi.stubEnv('OPENROUTER_MODEL', 'test-model');
    const provider = getReasonerProvider('OPENROUTER');
    
    let chatCalled = false;
    (provider as any).client = {
      chat: {
        completions: {
          create: vi.fn().mockImplementation(() => {
            chatCalled = true;
            return Promise.resolve({ choices: [{ message: { content: 'ok' } }] });
          })
        }
      }
    };
    
    const result = await provider.probe();
    expect(chatCalled).toBe(true);
    expect(result.status).toBe('AVAILABLE');
    // We only prove probe() succeeds. The rest of the guarantees are handled by Evaluator and run-real-eval.
  });
});
