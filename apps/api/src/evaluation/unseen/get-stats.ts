import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';

import * as path from 'path';

async function generateReportStats() {
  const dbUrl = 'file:' + path.join(process.cwd(), 'prisma', 'dev_unseen.db').replace(/\\/g, '/');
  const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });
  
  const cases = await prisma.recoveryCase.findMany({ include: { payment: true, customer: true } });
  
  const failureDistribution: Record<string, number> = {};
  const riskDistribution: Record<string, number> = {};
  const amountBands = { '<5000': 0, '=5000': 0, '>5000': 0 };
  const boundaries = { 4999: 0, 5000: 0, 5001: 0 };
  
  for (const c of cases) {
    const f = c.payment.failureCode!;
    const r = c.customer.riskTier;
    const a = c.payment.amount;
    
    failureDistribution[f] = (failureDistribution[f] || 0) + 1;
    riskDistribution[r] = (riskDistribution[r] || 0) + 1;
    
    if (a < 500000) amountBands['<5000']++;
    else if (a === 500000) amountBands['=5000']++;
    else amountBands['>5000']++;
    
    if (a === 499900) boundaries[4999]++;
    if (a === 500000) boundaries[5000]++;
    if (a === 500100) boundaries[5001]++;
  }

  const labelsPath = path.join(process.cwd(), 'src', 'evaluation', 'unseen', 'unseen-labels.json');
  const labels = JSON.parse(fs.readFileSync(labelsPath, 'utf8'));
  const actionDistribution: Record<string, number> = {};
  for (const l of labels) {
    actionDistribution[l.expectedAction] = (actionDistribution[l.expectedAction] || 0) + 1;
  }

  console.log('FAILURES:', failureDistribution);
  console.log('RISK:', riskDistribution);
  console.log('AMOUNTS:', amountBands);
  console.log('BOUNDARIES:', boundaries);
  console.log('ACTIONS:', actionDistribution);
}

generateReportStats().then(() => process.exit(0));
