export async function assertEvaluationDatabaseSafe(prisma: any): Promise<void> {
  // 1. Check Node Environment
  if (process.env.NODE_ENV !== 'development') {
    throw new Error('EVAL_RESET_BLOCKED: NODE_ENV is not development');
  }

  // 2. Check Database URL
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error('EVAL_RESET_BLOCKED: DATABASE_URL is missing');
  }

  if (!dbUrl.startsWith('file:') && !dbUrl.startsWith('sqlite:')) {
    throw new Error('EVAL_RESET_BLOCKED: DATABASE_URL is not SQLite');
  }

  if (!dbUrl.includes('dev.db') && !dbUrl.includes('dev_unseen.db')) {
    throw new Error('EVAL_RESET_BLOCKED: DATABASE_URL does not point to expected dev.db or dev_unseen.db');
  }

  // 3. Check Explicit Opt-in
  if (process.env.ALLOW_DESTRUCTIVE_EVAL_RESET !== 'true') {
    throw new Error('EVAL_RESET_BLOCKED: ALLOW_DESTRUCTIVE_EVAL_RESET is not true');
  }

  // 4. Verify Dataset Integrity
  await verifyEvaluationDatabaseIntegrity(prisma);
}

export async function verifyEvaluationDatabaseIntegrity(prisma: any): Promise<void> {
  // 1. Check Node Environment (shared logic)
  if (process.env.NODE_ENV !== 'development') {
    throw new Error('EVAL_DB_CHECK_FAILED: NODE_ENV is not development');
  }

  // 2. Check Database URL (shared logic)
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error('EVAL_DB_CHECK_FAILED: DATABASE_URL is missing');
  }

  if (!dbUrl.startsWith('file:') && !dbUrl.startsWith('sqlite:')) {
    throw new Error('EVAL_DB_CHECK_FAILED: DATABASE_URL is not SQLite');
  }

  if (!dbUrl.includes('dev.db') && !dbUrl.includes('dev_unseen.db')) {
    throw new Error('EVAL_DB_CHECK_FAILED: DATABASE_URL does not point to expected dev.db or dev_unseen.db');
  }

  try {
    const customerCount = await prisma.customer.count();
    const paymentCount = await prisma.payment.count();
    const successfulPayments = await prisma.payment.count({ where: { status: 'SUCCESS' } });
    const failedPayments = await prisma.payment.count({ where: { status: 'FAILED' } });
    const recoveryCaseCount = await prisma.recoveryCase.count();

    const isUnseen = dbUrl.includes('dev_unseen.db');
    
    if (isUnseen) {
      if (recoveryCaseCount !== 100) {
        throw new Error(`EVAL_DB_CHECK_FAILED: Unseen dataset integrity failure. Expected 100 cases. Found ${recoveryCaseCount} cases.`);
      }
    } else {
      if (
        customerCount !== 30 ||
        paymentCount !== 224 ||
        (successfulPayments + failedPayments) !== 224 ||
        recoveryCaseCount !== 58
      ) {
        throw new Error(`EVAL_DB_CHECK_FAILED: Dataset integrity failure. Expected 30 customers, 224 payments, 58 cases. Found ${customerCount} customers, ${paymentCount} payments, ${recoveryCaseCount} cases.`);
      }
    }
  } catch (err: any) {
    if (err.message.includes('EVAL_DB_CHECK_FAILED')) throw err;
    throw new Error('EVAL_DB_CHECK_FAILED: Database connectivity or schema issue. Inner: ' + err.message);
  }
}
