import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

export async function deriveUnseenLabels(prisma: PrismaClient) {
  console.log('🔍 Deriving unseen labels from authoritative SOP...');
  
  // Fetch authoritative SOP
  const sopPolicy = await prisma.policy.findFirst({
    where: { name: 'standard_operating_procedure_v1' }
  });

  if (!sopPolicy) {
    throw new Error('SOP policy not found in database');
  }

  const sop = JSON.parse(sopPolicy.conditions as string);
  const ruleMap = new Map<string, string>();
  
  for (const rule of sop.rules) {
    // Take the first appropriate action as expected
    ruleMap.set(rule.failureCategory, rule.appropriateActions[0]);
  }

  const cases = await prisma.recoveryCase.findMany({
    include: { payment: true }
  });

  if (cases.length === 0) {
    throw new Error('No cases found in DB to derive labels for');
  }

  const labels = [];

  for (const c of cases) {
    const failureCode = c.payment.failureCode;
    if (!failureCode || !ruleMap.has(failureCode)) {
      throw new Error(`AMBIGUITY: SOP cannot classify failureCode: ${failureCode}`);
    }

    labels.push({
      caseId: c.id,
      paymentId: c.payment.id,
      customerId: c.customerId,
      failureCode: failureCode,
      expectedAction: ruleMap.get(failureCode),
      amount: c.payment.amount
    });
  }

  const outPath = path.join(__dirname, 'unseen-labels.json');
  fs.writeFileSync(outPath, JSON.stringify(labels, null, 2));
  console.log(`✅ Unseen labels derived successfully for ${labels.length} cases.`);
  console.log(`📂 Saved to ${outPath}`);
  
  return labels;
}

if (require.main === module) {
  const dbUrl = 'file:' + path.join(process.cwd(), 'prisma', 'dev_unseen.db').replace(/\\/g, '/');
  const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });
  deriveUnseenLabels(prisma).then(() => {
    prisma.$disconnect();
  }).catch(e => {
    console.error(e);
    process.exit(1);
  });
}
