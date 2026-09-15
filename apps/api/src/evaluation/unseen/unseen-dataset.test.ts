import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { generateUnseenDataset } from './generate-dataset';
import { deriveUnseenLabels } from './derive-labels';
import * as path from 'path';

describe('Unseen Dataset Isolation & Diversity Tests', () => {
  let unseenPrisma: PrismaClient;
  let originalPrisma: PrismaClient;
  let unseenLabels: any[];

  beforeAll(async () => {
    const devDbPath = 'file:' + path.join(process.cwd(), 'prisma', 'dev.db').replace(/\\/g, '/');
    const unseenDbPath = 'file:' + path.join(process.cwd(), 'prisma', 'dev_unseen.db').replace(/\\/g, '/');
    // Connect to original db
    originalPrisma = new PrismaClient({ datasources: { db: { url: devDbPath } } });
    
    // Connect to in-memory/temp db for unseen
    unseenPrisma = new PrismaClient({ datasources: { db: { url: unseenDbPath } } });
    
    // We assume schema is already pushed to dev_unseen.db by the test runner
    await generateUnseenDataset(unseenPrisma);
    unseenLabels = await deriveUnseenLabels(unseenPrisma);
  });

  afterAll(async () => {
    await originalPrisma.$disconnect();
    await unseenPrisma.$disconnect();
  });

  it('generates exactly 100 cases', async () => {
    const caseCount = await unseenPrisma.recoveryCase.count();
    expect(caseCount).toBe(100);
    expect(unseenLabels.length).toBe(100);
  });

  it('uses isolated namespaces for IDs', async () => {
    const cases = await unseenPrisma.recoveryCase.findMany({ include: { customer: true, payment: true } });
    for (const c of cases) {
      expect(c.id).toContain('case_unseen_');
      expect(c.payment.externalId).toContain('pay_unseen_');
      expect(c.customer.externalId).toContain('cust_unseen_');
    }
  });

  it('does not leak expected actions into DB schema', async () => {
    const payments = await unseenPrisma.payment.findMany();
    for (const p of payments) {
      const keys = Object.keys(p);
      expect(keys).not.toContain('expectedAction');
      // Ensure gatewayResponse doesn't have it either
      expect(p.gatewayResponse).not.toContain('expectedAction');
    }
  });

  it('contains no exact signature collisions with original 58 cases', async () => {
    const originalCases = await originalPrisma.recoveryCase.findMany({ include: { payment: true, customer: true } });
    const unseenCases = await unseenPrisma.recoveryCase.findMany({ include: { payment: true, customer: true } });
    
    const getSignature = (c: any) => 
      `${c.payment.failureCode}:${c.customer.riskTier}:${c.payment.amount}:${c.customer.totalPayments}:${c.customer.failedPayments}`;

    const originalSignatures = new Set(originalCases.map(getSignature));
    
    let collisions = 0;
    for (const uc of unseenCases) {
      const sig = getSignature(uc);
      if (originalSignatures.has(sig)) {
        collisions++;
      }
    }
    
    expect(collisions).toBe(0);
  });

  it('has structural diversity compared to original cases', async () => {
    const unseenCases = await unseenPrisma.recoveryCase.findMany({ include: { payment: true, customer: true } });
    
    // Extract combinations
    const failureRiskCombos = new Set();
    const failureAmountCombos = new Set();
    const amounts = new Set();
    const failureCodes = new Set();
    const riskTiers = new Set();

    for (const c of unseenCases) {
      failureRiskCombos.add(`${c.payment.failureCode}:${c.customer.riskTier}`);
      failureAmountCombos.add(`${c.payment.failureCode}:${c.payment.amount}`);
      amounts.add(c.payment.amount);
      failureCodes.add(c.payment.failureCode);
      riskTiers.add(c.customer.riskTier);
    }

    // Must have all 7 failure codes
    expect(failureCodes.size).toBe(7);
    
    // Must have all 3 risk tiers
    expect(riskTiers.size).toBe(3);

    // Check specific boundary amounts
    expect(amounts.has(499900)).toBe(true);
    expect(amounts.has(500000)).toBe(true);
    expect(amounts.has(500100)).toBe(true);
  });

  it('verifies deterministic generation', async () => {
    // Wipe and regenerate
    await generateUnseenDataset(unseenPrisma);
    const newLabels = await deriveUnseenLabels(unseenPrisma);
    
    expect(newLabels).toEqual(unseenLabels); // Same seed yields exact same cases/labels
  });

});
