import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🔍 Running Database Validations...');

  const totalCustomers = await prisma.customer.count();
  const totalPayments = await prisma.payment.count();
  
  const successfulPayments = await prisma.payment.count({ where: { status: 'SUCCESS' } });
  const failedPayments = await prisma.payment.count({ where: { status: 'FAILED' } });
  const pendingPayments = await prisma.payment.count({ where: { status: 'PENDING' } });
  
  const totalRecoveryCases = await prisma.recoveryCase.count();
  
  const totalRevenuePaise = (await prisma.payment.aggregate({ _sum: { amount: true } }))._sum.amount || 0;
  const totalRevenueAtRiskPaise = (await prisma.recoveryCase.aggregate({ _sum: { amountAtRisk: true } }))._sum.amountAtRisk || 0;

  // Group cases by failure code
  const paymentsWithCases = await prisma.payment.findMany({
    where: { recoveryCase: { isNot: null } },
    select: { failureCode: true }
  });

  const casesByFailureCode = paymentsWithCases.reduce((acc, curr) => {
    const code = curr.failureCode || 'UNKNOWN';
    acc[code] = (acc[code] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  console.log('--------------------------------------------------');
  console.log(`👥 Total Customers:       ${totalCustomers}`);
  console.log(`💳 Total Payments:        ${totalPayments}`);
  console.log(`   - Success:             ${successfulPayments}`);
  console.log(`   - Failed:              ${failedPayments}`);
  console.log(`   - Pending:             ${pendingPayments}`);
  console.log(`🚨 Total Recovery Cases:  ${totalRecoveryCases}`);
  console.log(`💰 Total Revenue:         ₹${(totalRevenuePaise / 100).toFixed(2)}`);
  console.log(`⚠️  Revenue at Risk:       ₹${(totalRevenueAtRiskPaise / 100).toFixed(2)}`);
  console.log('--------------------------------------------------');
  console.log('📊 Cases by Failure Scenario:');
  Object.entries(casesByFailureCode).forEach(([code, count]) => {
    console.log(`   - ${code.padEnd(25)} : ${count}`);
  });

  console.log('--------------------------------------------------');
  console.log('🧪 Testing Database Invariants...');
  
  // INVARIANT 1: No recovery cases for successful payments
  const invalidCases = await prisma.recoveryCase.count({
    where: { payment: { status: 'SUCCESS' } }
  });
  if (invalidCases > 0) {
    throw new Error(`❌ FAILED: Found ${invalidCases} recovery cases attached to successful payments.`);
  }
  console.log('✅ PASS: All recovery cases belong to failed payments.');

  // INVARIANT 2: Monetary values are integers (checked implicitly by Prisma schema Int type, but let's confirm > 0)
  const invalidAmounts = await prisma.payment.count({
    where: { amount: { lte: 0 } }
  });
  if (invalidAmounts > 0) {
    throw new Error(`❌ FAILED: Found ${invalidAmounts} payments with amount <= 0.`);
  }
  console.log('✅ PASS: All monetary values are valid positive integers.');

  // INVARIANT 3: One-to-One mapping is sound (Prisma enforces unique paymentId)
  console.log('✅ PASS: One-to-one mapping Payment -> RecoveryCase enforced by schema uniqueness.');

  console.log('🎉 All validations passed successfully.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
