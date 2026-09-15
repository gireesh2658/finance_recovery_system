import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'child_process';
import { PrismaClient } from '@prisma/client';
import path from 'path';

describe('Dry-Run Isolation (Step 22)', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = new PrismaClient();
  });

  it('A-G. dry-run outputs correct zero-mutation metrics and respects boundaries', async () => {
    // 1. Get initial database counts
    const initialCases = await prisma.recoveryCase.count();
    const initialDecisions = await prisma.agentDecision.count();
    const initialPayments = await prisma.payment.count();

    // 2. Execute dry run in a child process
    const scriptPath = path.join(__dirname, 'run-real-eval.ts');
    let output = '';
    try {
      output = execSync(`npx tsx "${scriptPath}" --dry-run`, { 
        encoding: 'utf-8', 
        env: { 
          ...process.env, 
          NODE_ENV: 'development', 
          AI_PROVIDER: 'OPENROUTER', 
          OPENROUTER_API_KEY: 'test-key',
          OPENROUTER_MODEL: 'test-model'
        } 
      });
    } catch (e: any) {
      // Dry-run exits non-zero when database safety check fails (e.g. empty DB after eval reset).
      // The output still contains the zero-mutation metrics we need to verify.
      output = (e.stdout || '') + (e.stderr || '');
    }

    // 3. Assert exact output requirements
    expect(output).toContain('REAL LLM EVALUATION — DRY RUN');
    expect(output).toContain('Provider: OPENROUTER');
    expect(output).toContain('Database mutations: 0');
    expect(output).toContain('LLM requests: 0');
    expect(output).not.toContain('Gemini requests:');
    expect(output).toContain('Recovery actions: 0');
    expect(output).toContain('DRY-RUN VALIDATION COMPLETED');
    expect(output).not.toContain('Resetting database environment');
    expect(output).not.toContain('Running evaluation via');

    // 4. Assert zero database mutations happened
    const finalCases = await prisma.recoveryCase.count();
    const finalDecisions = await prisma.agentDecision.count();
    const finalPayments = await prisma.payment.count();

    expect(finalCases).toBe(initialCases);
    expect(finalDecisions).toBe(initialDecisions);
    expect(finalPayments).toBe(initialPayments);
  });
});
