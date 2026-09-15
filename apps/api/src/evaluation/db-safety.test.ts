import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { assertEvaluationDatabaseSafe } from './db-safety';

describe('Database Reset Safety Guard', () => {
  let mockPrisma: any;

  beforeEach(() => {
    process.env.NODE_ENV = 'development';
    process.env.DATABASE_URL = 'file:./dev.db';
    process.env.ALLOW_DESTRUCTIVE_EVAL_RESET = 'true';

    mockPrisma = {
      customer: { count: vi.fn().mockResolvedValue(30) },
      payment: { count: vi.fn().mockImplementation((args: any) => {
        if (args?.where?.status === 'SUCCESS') return 166;
        if (args?.where?.status === 'FAILED') return 58;
        return 224;
      })},
      recoveryCase: { count: vi.fn().mockResolvedValue(58) }
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('A. Valid evaluation database + opt-in -> allowed', async () => {
    await expect(assertEvaluationDatabaseSafe(mockPrisma)).resolves.not.toThrow();
  });

  it('B. Production environment -> reset denied', async () => {
    process.env.NODE_ENV = 'production';
    await expect(assertEvaluationDatabaseSafe(mockPrisma)).rejects.toThrow('NODE_ENV is not development');
  });

  it('C. Missing DATABASE_URL -> reset denied', async () => {
    delete process.env.DATABASE_URL;
    await expect(assertEvaluationDatabaseSafe(mockPrisma)).rejects.toThrow('DATABASE_URL is missing');
  });

  it('D. Non-SQLite database -> reset denied', async () => {
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db';
    await expect(assertEvaluationDatabaseSafe(mockPrisma)).rejects.toThrow('DATABASE_URL is not SQLite');
  });

  it('E. Wrong SQLite database path -> reset denied', async () => {
    process.env.DATABASE_URL = 'file:./production.db';
    await expect(assertEvaluationDatabaseSafe(mockPrisma)).rejects.toThrow('DATABASE_URL does not point to expected dev.db');
  });

  it('F. Missing destructive opt-in -> reset denied', async () => {
    delete process.env.ALLOW_DESTRUCTIVE_EVAL_RESET;
    await expect(assertEvaluationDatabaseSafe(mockPrisma)).rejects.toThrow('ALLOW_DESTRUCTIVE_EVAL_RESET is not true');
  });

  it('G. Ambiguous data (missing seeded cases) -> reset denied', async () => {
    mockPrisma.recoveryCase.count.mockResolvedValue(57); // Missing a case
    await expect(assertEvaluationDatabaseSafe(mockPrisma)).rejects.toThrow('Dataset integrity failure');
  });
});
