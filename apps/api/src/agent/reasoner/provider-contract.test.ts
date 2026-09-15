import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getReasonerProvider } from './factory';
import { OpenRouterReasonerProvider } from './openrouter-provider';
import { BaselineEvaluationProvider } from '../../evaluation/baseline-provider';

describe('Provider Contract', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('A. all providers expose reason()', () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
    vi.stubEnv('OPENROUTER_MODEL', 'test-model');
    const openrouter = getReasonerProvider('OPENROUTER');
    expect(typeof openrouter.reason).toBe('function');

    const baseline = getReasonerProvider('BASELINE');
    expect(typeof baseline.reason).toBe('function');
  });

  it('B. all providers expose probe()', () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
    vi.stubEnv('OPENROUTER_MODEL', 'test-model');
    const openrouter = getReasonerProvider('OPENROUTER');
    expect(typeof openrouter.probe).toBe('function');

    const baseline = getReasonerProvider('BASELINE');
    expect(typeof baseline.probe).toBe('function');
  });

  it('C. probe performs no retry', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
    vi.stubEnv('OPENROUTER_MODEL', 'test-model');
    const openrouter = getReasonerProvider('OPENROUTER');
    
    let callCount = 0;
    (openrouter as any).client = {
      chat: {
        completions: {
          create: vi.fn().mockImplementation(() => {
            callCount++;
            return Promise.reject(new Error('transient failure'));
          })
        }
      }
    };
    
    const result = await openrouter.probe();
    expect(callCount).toBe(1); // Exactly one request
    expect(result.status).not.toBe('AVAILABLE');
  });

  it('H. OpenRouter provider normalizes errors', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
    vi.stubEnv('OPENROUTER_MODEL', 'test-model');
    const openrouter = getReasonerProvider('OPENROUTER');
    
    (openrouter as any).client = {
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue({ status: 429, message: 'Too many requests' })
        }
      }
    };
    
    const result = await openrouter.probe();
    expect(result.status).toBe('RATE_LIMIT_OR_QUOTA_EXHAUSTED');
  });

  it('I. BASELINE remains offline', async () => {
    const baseline = getReasonerProvider('BASELINE');
    const result = await baseline.probe();
    expect(result.status).toBe('AVAILABLE');
    
    // baseline shouldn't have any client attached
    expect((baseline as any).client).toBeUndefined();
  });

  it('J. provider selection is deterministic', () => {
    expect(getReasonerProvider('BASELINE')).toBeInstanceOf(BaselineEvaluationProvider);

    vi.stubEnv('OPENROUTER_API_KEY', 'test');
    vi.stubEnv('OPENROUTER_MODEL', 'test');
    expect(getReasonerProvider('OPENROUTER')).toBeInstanceOf(OpenRouterReasonerProvider);
  });

  it('K. unknown provider fails immediately', () => {
    expect(() => getReasonerProvider('UNKNOWN')).toThrow(/UNKNOWN_PROVIDER/);
  });
  
  it('L. removed providers fail immediately', () => {
    expect(() => getReasonerProvider('GEMINI')).toThrow(/UNKNOWN_PROVIDER/);
    expect(() => getReasonerProvider('OPENAI')).toThrow(/UNKNOWN_PROVIDER/);
  });
});
