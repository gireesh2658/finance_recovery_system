import { PrismaClient } from '@prisma/client';

export const UNSEEN_SEED = 98765;

// Simple deterministic random number generator (Linear Congruential Generator)
class LCG {
  private seed: number;
  constructor(seed: number) {
    this.seed = seed;
  }
  next(): number {
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }
  nextInt(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }
  pick<T>(array: T[]): T {
    return array[this.nextInt(0, array.length - 1)];
  }
}

const FAILURE_CODES = [
  'INSUFFICIENT_FUNDS',
  'CARD_EXPIRED',
  'BANK_DECLINED',
  'NETWORK_TIMEOUT',
  'GATEWAY_ERROR',
  'INVALID_PAYMENT_METHOD',
  'REPEATED_FAILURE',
];

const TARGET_AMOUNTS = [
  100000, 200000, 499900, 500000, 500100, 600000, 1000000
];

export async function generateUnseenDataset(prisma: PrismaClient) {
  console.log('🌱 Generating Unseen 100-Case Dataset...');
  
  // Wipe everything in this specific database
  await prisma.auditEvent.deleteMany();
  await prisma.agentDecision.deleteMany();
  await prisma.recoveryAttempt.deleteMany();
  await prisma.recoveryCase.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.customer.deleteMany();
  await prisma.policy.deleteMany();

  // Seed Policies (same as dev.db to represent the application's actual SOP)
  await prisma.policy.createMany({
    data: [
      {
        name: 'global_max_retries',
        description: 'Limits the maximum number of automated retries per case',
        ruleType: 'MAX_RETRIES',
        conditions: JSON.stringify({ maxRetries: 3 }),
        priority: 100,
      },
      {
        name: 'network_timeout_allowed_actions',
        description: 'Allowed actions for network timeout failures',
        ruleType: 'ALLOWED_ACTIONS',
        conditions: JSON.stringify({ failureCode: 'NETWORK_TIMEOUT', allowedActions: ['RETRY_PAYMENT', 'ESCALATE_TO_HUMAN'] }),
        priority: 90,
      },
      {
        name: 'insufficient_funds_cooldown',
        description: 'Mandatory cooldown before retrying insufficient funds',
        ruleType: 'COOLDOWN',
        conditions: JSON.stringify({ failureCode: 'INSUFFICIENT_FUNDS', hours: 24 }),
        priority: 80,
      },
      {
        name: 'high_value_escalation',
        description: 'Automatically escalate failures over 50,000 INR',
        ruleType: 'AMOUNT_LIMIT',
        conditions: JSON.stringify({ maxAmountPaise: 5000000, exceedAction: 'ESCALATE_TO_HUMAN' }),
        priority: 110,
      },
      {
        name: 'standard_operating_procedure_v1',
        description: 'Primary Recovery Policy SOP for Reasoner Mappings',
        ruleType: 'STANDARD_OPERATING_PROCEDURE',
        conditions: JSON.stringify({
          policyVersion: '1.0.0',
          rules: [
            {
              failureCategory: 'INSUFFICIENT_FUNDS',
              guidance: 'Customer should be informed that payment could not be completed because funds were insufficient.',
              appropriateActions: ['NOTIFY_CUSTOMER']
            },
            {
              failureCategory: 'BANK_DECLINED',
              guidance: 'Customer should be informed that the bank declined the transaction. Blind retries are prohibited without customer intervention.',
              appropriateActions: ['NOTIFY_CUSTOMER']
            },
            {
              failureCategory: 'INVALID_PAYMENT_METHOD',
              guidance: 'Customer must provide a valid supported payment method via a new secure link.',
              appropriateActions: ['SEND_PAYMENT_LINK']
            },
            {
              failureCategory: 'CARD_EXPIRED',
              guidance: 'Customer needs to provide a valid payment method since the card expired. A payment link is appropriate.',
              appropriateActions: ['SEND_PAYMENT_LINK']
            },
            {
              failureCategory: 'GATEWAY_ERROR',
              guidance: 'Retry may be appropriate when the failure is transient and retry policy permits it.',
              appropriateActions: ['RETRY_PAYMENT']
            },
            {
              failureCategory: 'NETWORK_TIMEOUT',
              guidance: 'Retry may be appropriate when the transaction may have failed transiently and retry policy permits it.',
              appropriateActions: ['RETRY_PAYMENT']
            },
            {
              failureCategory: 'REPEATED_FAILURE',
              guidance: 'Repeated unsuccessful attempts indicate high risk and must be escalated to a human agent immediately.',
              appropriateActions: ['ESCALATE_TO_HUMAN']
            }
          ]
        }),
        priority: 1000,
      }
    ]
  });

  const random = new LCG(UNSEEN_SEED);
  const totalCasesToGenerate = 100;
  
  // We will distribute the cases directly across permutations of (riskTier, failureCode, amountTarget)
  // to ensure diversity.
  
  const riskTiers: string[] = ['LOW', 'MEDIUM', 'HIGH'];
  let caseCount = 0;
  
  // Pre-generate customer records
  const customers = [];
  for (let i = 1; i <= 50; i++) {
    const riskTier = riskTiers[i % riskTiers.length];
    const customerId = `cust_unseen_${random.nextInt(10000, 99999)}_${i}`;
    const customer = await prisma.customer.create({
      data: {
        id: customerId,
        externalId: customerId,
        name: `Unseen Customer ${i}`,
        email: `unseen${i}@synthetic.local`,
        phone: `+9198${random.nextInt(10000000, 99999999)}`,
        riskTier,
        totalPayments: 0,
        failedPayments: 0
      }
    });
    customers.push(customer);
  }
  
  let i = 0;
  while (caseCount < totalCasesToGenerate) {
    const customer = customers[random.nextInt(0, customers.length - 1)];
    const failureCode = FAILURE_CODES[i % FAILURE_CODES.length];
    
    // Mix targeted boundaries and random amounts
    const isBoundaryTarget = random.next() > 0.5;
    const amountPaise = isBoundaryTarget 
      ? TARGET_AMOUNTS[random.nextInt(0, TARGET_AMOUNTS.length - 1)] 
      : random.nextInt(5000, 500000); // generic small to medium

    const paymentId = `pay_unseen_${random.nextInt(100000, 999999)}_${caseCount}`;
    const payment = await prisma.payment.create({
      data: {
        id: paymentId,
        externalId: paymentId,
        customerId: customer.id,
        amount: amountPaise,
        currency: 'INR',
        status: 'FAILED',
        method: random.pick(['CARD', 'UPI', 'NETBANKING']),
        failureCode: failureCode,
        failureReason: `Unseen reason for ${failureCode}`,
        gatewayResponse: JSON.stringify({ error: failureCode, unseen: true }),
        attemptedAt: new Date(Date.now() - random.nextInt(1000, 100000000)),
      }
    });
    
    await prisma.customer.update({
      where: { id: customer.id },
      data: {
        totalPayments: { increment: random.nextInt(1, 3) }, // simulate total payments >= failed
        failedPayments: { increment: 1 }
      }
    });

    await prisma.recoveryCase.create({
      data: {
        id: `case_unseen_${random.nextInt(100000, 999999)}_${caseCount}`,
        paymentId: payment.id,
        customerId: customer.id,
        status: 'DETECTED',
        amountAtRisk: payment.amount,
        priority: amountPaise > 200000 ? 'HIGH' : 'MEDIUM',
      }
    });
    
    caseCount++;
    i++;
  }

  console.log(`✅ Seeding unseen dataset complete! Cases generated: ${caseCount}`);
}

// Allow running standalone
if (require.main === module) {
  const path = require('path');
  const dbUrl = 'file:' + path.join(process.cwd(), 'prisma', 'dev_unseen.db').replace(/\\/g, '/');
  const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });
  generateUnseenDataset(prisma).then(() => {
    prisma.$disconnect();
    console.log('Unseen DB created at prisma/dev_unseen.db');
  }).catch(e => {
    console.error(e);
    process.exit(1);
  });
}
