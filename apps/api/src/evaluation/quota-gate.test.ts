import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenRouterReasonerProvider } from '../agent/reasoner/openrouter-provider';

describe('Provider Capacity Gate (Quota Gate)', () => {
  let provider: OpenRouterReasonerProvider;

  beforeEach(() => {
    // Reset env vars before each test to prevent bleed
    vi.unstubAllEnvs();
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
    vi.stubEnv('OPENROUTER_MODEL', 'test-model');
    provider = new OpenRouterReasonerProvider();
  });

  it('A. Missing API key → configuration FAIL', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', '');
    expect(() => new OpenRouterReasonerProvider()).toThrow('CONFIGURATION_ERROR');
  });

  it('B. Authentication failure → gate FAIL', async () => {
    (provider as any).client = {
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue({ status: 401, message: 'API key not valid' })
        }
      }
    };
    const result = await provider.probe();
    expect(result.status).toBe('AUTHENTICATION_FAILURE');
  });

  it('C. HTTP 429 → gate FAIL', async () => {
    (provider as any).client = {
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue({ status: 429, message: 'Too Many Requests' })
        }
      }
    };
    const result = await provider.probe();
    expect(result.status).toBe('RATE_LIMIT_OR_QUOTA_EXHAUSTED');
  });

  it('D. RESOURCE_EXHAUSTED → gate FAIL', async () => {
    (provider as any).client = {
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue({ status: 402, message: 'Insufficient balance' })
        }
      }
    };
    const result = await provider.probe();
    expect(result.status).toBe('RATE_LIMIT_OR_QUOTA_EXHAUSTED');
  });

  it('E. Network failure → gate FAIL', async () => {
    (provider as any).client = {
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue({ code: 'ECONNRESET', message: 'fetch failed' })
        }
      }
    };
    const result = await provider.probe();
    expect(result.status).toBe('NETWORK_FAILURE');
  });

  it('F. Timeout → gate FAIL', async () => {
    (provider as any).client = {
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue({ name: 'AbortError' })
        }
      }
    };
    const result = await provider.probe();
    expect(result.status).toBe('TIMEOUT');
  });

  it('G. Successful provider response → gate PASS', async () => {
    (provider as any).client = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({ 
            choices: [{ message: { content: 'hello' } }] 
          })
        }
      }
    };
    const result = await provider.probe();
    expect(result.status).toBe('AVAILABLE');
  });

});
