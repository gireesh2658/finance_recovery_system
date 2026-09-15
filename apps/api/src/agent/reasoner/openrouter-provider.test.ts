import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenRouterReasonerProvider } from './openrouter-provider';

describe('OpenRouter Provider', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    // Set minimum valid configuration
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key-not-real');
    vi.stubEnv('OPENROUTER_MODEL', 'zhipu/glm-z1-9b:free');
    vi.stubEnv('OPENROUTER_BASE_URL', 'https://openrouter.ai/api/v1');
    vi.stubEnv('AI_TIMEOUT_MS', '15000');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // --- Configuration ---

  it('A. Missing API key fails safely', () => {
    vi.stubEnv('OPENROUTER_API_KEY', '');
    expect(() => new OpenRouterReasonerProvider()).toThrow('CONFIGURATION_ERROR: OPENROUTER_API_KEY is missing');
  });

  it('B. Missing model fails safely', () => {
    vi.stubEnv('OPENROUTER_MODEL', '');
    expect(() => new OpenRouterReasonerProvider()).toThrow('CONFIGURATION_ERROR: OPENROUTER_MODEL is missing');
  });

  it('C. Invalid configuration makes zero HTTP requests', () => {
    vi.stubEnv('OPENROUTER_API_KEY', '');
    let callCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((..._args: Parameters<typeof fetch>) => { callCount++; return originalFetch(..._args); }) as typeof fetch;
    
    try {
      new OpenRouterReasonerProvider();
    } catch {
      // Expected
    }
    
    globalThis.fetch = originalFetch;
    expect(callCount).toBe(0);
  });

  it('D. API key never appears in thrown errors', () => {
    vi.stubEnv('OPENROUTER_API_KEY', '');
    try {
      new OpenRouterReasonerProvider();
    } catch (e: any) {
      expect(e.message).not.toContain('test-key-not-real');
      expect(e.message).not.toContain('sk-or-');
    }
  });

  // --- Probe ---

  it('E. Successful probe passes', async () => {
    const provider = new OpenRouterReasonerProvider();
    (provider as any).client = {
      chat: { completions: { create: vi.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' } }] }) } }
    };
    const result = await provider.probe();
    expect(result.status).toBe('AVAILABLE');
  });

  it('F. 401/403 → authentication failure', async () => {
    const provider = new OpenRouterReasonerProvider();
    (provider as any).client = {
      chat: { completions: { create: vi.fn().mockRejectedValue({ status: 401, message: 'Unauthorized' }) } }
    };
    const result = await provider.probe();
    expect(result.status).toBe('AUTHENTICATION_FAILURE');
  });

  it('G. 429 → rate-limit/quota failure', async () => {
    const provider = new OpenRouterReasonerProvider();
    (provider as any).client = {
      chat: { completions: { create: vi.fn().mockRejectedValue({ status: 429, message: 'Rate limit' }) } }
    };
    const result = await provider.probe();
    expect(result.status).toBe('RATE_LIMIT_OR_QUOTA_EXHAUSTED');
  });

  it('H. network failure → network failure', async () => {
    const provider = new OpenRouterReasonerProvider();
    (provider as any).client = {
      chat: { completions: { create: vi.fn().mockRejectedValue({ code: 'ECONNRESET', message: 'fetch failed' }) } }
    };
    const result = await provider.probe();
    expect(result.status).toBe('NETWORK_FAILURE');
  });

  it('I. timeout → timeout', async () => {
    const provider = new OpenRouterReasonerProvider();
    (provider as any).client = {
      chat: { completions: { create: vi.fn().mockRejectedValue({ name: 'AbortError' }) } }
    };
    const result = await provider.probe();
    expect(result.status).toBe('TIMEOUT');
  });

  it('K. probe makes at most one request', async () => {
    const provider = new OpenRouterReasonerProvider();
    let callCount = 0;
    (provider as any).client = {
      chat: { completions: { create: vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.reject({ status: 429, message: 'Rate limit' });
      }) } }
    };
    await provider.probe();
    expect(callCount).toBe(1);
  });

  it('L. probe never retries', async () => {
    const provider = new OpenRouterReasonerProvider();
    let callCount = 0;
    (provider as any).client = {
      chat: { completions: { create: vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.reject({ status: 500, message: 'Server error' });
      }) } }
    };
    await provider.probe();
    expect(callCount).toBe(1);
  });

  // --- Reasoning ---

  it('P. Successful reasoning returns structured result', async () => {
    const provider = new OpenRouterReasonerProvider();
    const mockResponse = {
      diagnosisCode: 'NETWORK_TIMEOUT',
      diagnosisSummary: 'Network timeout detected',
      diagnosisConfidence: 0.9,
      recommendedAction: 'RETRY_PAYMENT',
      recommendationConfidence: 0.85,
      recommendationReason: 'Transient network failure',
      alternativeActions: ['ESCALATE_TO_HUMAN'],
      escalationRecommendation: false,
    };
    
    (provider as any).client = {
      chat: { completions: { create: vi.fn().mockResolvedValue({
        choices: [{ message: { content: JSON.stringify(mockResponse) } }]
      }) } }
    };
    
    const context = {
      caseId: 'test-case-1',
      payment: { amountPaise: 10000, currency: 'INR', method: 'UPI', failureCode: 'NETWORK_TIMEOUT', failureReason: 'Timeout' },
      customer: { riskTier: 'LOW', successfulPayments: 5, failedPayments: 1 },
      recoveryState: { status: 'DETECTED', attemptCount: 0 },
      policiesSummary: ['max_retry_3'],
    };
    
    const result = await provider.reason(context);
    expect(result).toEqual(mockResponse);
  });

  it('Q. Provider failure preserves normalized error', async () => {
    const provider = new OpenRouterReasonerProvider();
    (provider as any).client = {
      chat: { completions: { create: vi.fn().mockRejectedValue({ status: 401, message: 'Auth failed' }) } }
    };
    
    const context = {
      caseId: 'test-case-2',
      payment: { amountPaise: 10000, currency: 'INR', method: 'UPI', failureCode: 'X', failureReason: 'X' },
      customer: { riskTier: 'LOW', successfulPayments: 0, failedPayments: 0 },
      recoveryState: { status: 'DETECTED', attemptCount: 0 },
      policiesSummary: [],
    };
    
    await expect(provider.reason(context)).rejects.toThrow('PROVIDER_AUTH_FAILURE');
  });

  // --- Structured Output Contract (Step 34) ---

  it('R. Valid JSON object', async () => {
    const provider = new OpenRouterReasonerProvider();
    const validJson = { action: 'test' };
    (provider as any).client = {
      chat: { completions: { create: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify(validJson) } }] }) } }
    };
    const result = await provider.reason({} as any);
    expect(result).toEqual(validJson);
  });

  it('S. Invalid JSON throws malformed output', async () => {
    const provider = new OpenRouterReasonerProvider();
    (provider as any).client = {
      chat: { completions: { create: vi.fn().mockResolvedValue({ choices: [{ message: { content: 'not json' } }] }) } }
    };
    await expect(provider.reason({} as any)).rejects.toThrow();
  });

  // Note: Tests for D (Missing required fields), E (Invalid action), and F (Unexpected extra fields)
  // are structurally evaluated by ReasonerService (tested in reasoner.test.ts) since the provider
  // is agnostic to the domain schema and only enforces the JSON specification boundary.

  // --- Factory ---

  it('W. OPENROUTER resolves to OpenRouter provider', async () => {
    const { getReasonerProvider } = await import('./factory');
    const provider = getReasonerProvider('OPENROUTER');
    expect(provider).toBeInstanceOf(OpenRouterReasonerProvider);
  });

  it('X. Unknown provider fails immediately', async () => {
    const { getReasonerProvider } = await import('./factory');
    expect(() => getReasonerProvider('NONEXISTENT')).toThrow(/UNKNOWN_PROVIDER/);
  });

  it('Y. No provider silently falls back to another provider', async () => {
    const { getReasonerProvider } = await import('./factory');
    const provider = getReasonerProvider('OPENROUTER');
    // Verify it's specifically OpenRouterReasonerProvider, not OpenAI or Gemini
    expect(provider.constructor.name).toBe('OpenRouterReasonerProvider');
  });

  // --- Security ---

  it('Z. API key is read only from environment', () => {
    const provider = new OpenRouterReasonerProvider();
    // Verify the model property is accessible but the API key is not exposed
    // on the provider's own properties
    expect((provider as any).model).toBe('zhipu/glm-z1-9b:free');
    // The apiKey is only inside the client, never on the provider surface
    expect((provider as any).apiKey).toBeUndefined();
  });

  it('AB. Errors/logs do not expose the secret', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-v1-secretvalue123');
    const provider = new OpenRouterReasonerProvider();
    (provider as any).client = {
      chat: { completions: { create: vi.fn().mockRejectedValue(
        new Error('Request failed with sk-or-v1-secretvalue123 in the message')
      ) } }
    };
    
    const result = await provider.probe();
    if (result.status !== 'AVAILABLE') {
      expect((result as any).error).not.toContain('sk-or-v1-secretvalue123');
      expect((result as any).error).toContain('[REDACTED]');
    }
  });
});
