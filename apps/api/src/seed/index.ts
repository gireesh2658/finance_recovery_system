import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();

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

const random = new LCG(12345); // Fixed seed for reproducibility

const FAILURE_SCENARIOS = [
  { code: 'INSUFFICIENT_FUNDS', reason: 'Customer account has insufficient balance', expectedAction: 'NOTIFY_CUSTOMER' },
  { code: 'CARD_EXPIRED', reason: 'The card used for the transaction has expired', expectedAction: 'SEND_PAYMENT_LINK' },
  { code: 'BANK_DECLINED', reason: 'The issuing bank declined the transaction', expectedAction: 'NOTIFY_CUSTOMER' },
  { code: 'NETWORK_TIMEOUT', reason: 'Gateway timed out while waiting for bank response', expectedAction: 'RETRY_PAYMENT' },
  { code: 'GATEWAY_ERROR', reason: 'Internal error at the payment gateway', expectedAction: 'RETRY_PAYMENT' },
  { code: 'INVALID_PAYMENT_METHOD', reason: 'The selected payment method is not supported', expectedAction: 'SEND_PAYMENT_LINK' },
  { code: 'REPEATED_FAILURE', reason: 'Card has been repeatedly declined', expectedAction: 'ESCALATE_TO_HUMAN' },
];

async function main() {
  console.log('🌱 Starting deterministic seed process...');

  // 1. Clean existing data
  console.log('Cleaning existing data...');
  await prisma.auditEvent.deleteMany();
  await prisma.agentDecision.deleteMany();
  await prisma.recoveryAttempt.deleteMany();
  await prisma.recoveryCase.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.customer.deleteMany();
  await prisma.policy.deleteMany();

  // 2. Seed Policies
  console.log('Seeding policies...');
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

  // 3. Generate Customers & Payments
  console.log('Seeding customers and payments...');
  
  const groundTruthMetadata: any[] = [];
  const TOTAL_CUSTOMERS = 30;
  
  let paymentCount = 0;
  let recoveryCaseCount = 0;
  let totalRevenueAtRisk = 0;

  for (let i = 1; i <= TOTAL_CUSTOMERS; i++) {
    const isHighRisk = random.next() > 0.8;
    const customerRisk = isHighRisk ? 'HIGH' : (random.next() > 0.5 ? 'MEDIUM' : 'LOW');
    
    // Generate customer
    const customer = await prisma.customer.create({
      data: {
        externalId: `cust_fake_${random.nextInt(1000, 9999)}_${i}`,
        name: `Synthetic Customer ${i}`,
        email: `customer${i}@synthetic.local`,
        phone: `+9198${random.nextInt(10000000, 99999999)}`,
        riskTier: customerRisk,
      }
    });

    // Generate 3 to 10 payments per customer to build history
    const numPayments = random.nextInt(3, 10);
    let customerTotalPayments = 0;
    let customerFailedPayments = 0;

    for (let p = 1; p <= numPayments; p++) {
      const amountPaise = random.nextInt(5000, 500000); // 50 INR to 5000 INR
      
      // Determine if this payment fails.
      // Make the most recent payment more likely to fail so we have open recovery cases.
      // High risk customers fail more often.
      const isLastPayment = p === numPayments;
      let fails = false;
      
      if (isLastPayment) {
        fails = random.next() > 0.3; // 70% chance the last payment fails (creates our active cases)
      } else {
        fails = isHighRisk ? (random.next() > 0.6) : (random.next() > 0.8);
      }

      const status = fails ? 'FAILED' : 'SUCCESS';
      const scenario = fails ? random.pick(FAILURE_SCENARIOS) : null;
      
      const payment = await prisma.payment.create({
        data: {
          externalId: `pay_fake_${random.nextInt(10000, 99999)}_${i}_${p}`,
          customerId: customer.id,
          amount: amountPaise,
          currency: 'INR',
          status: status,
          method: random.pick(['CARD', 'UPI', 'NETBANKING']),
          failureCode: scenario?.code || null,
          failureReason: scenario?.reason || null,
          gatewayResponse: fails ? JSON.stringify({ error: scenario?.code, bank_message: 'Simulated decline' }) : JSON.stringify({ auth: 'ok' }),
          attemptedAt: new Date(Date.now() - random.nextInt(1000, 100000000)), // Past dates
        }
      });
      
      customerTotalPayments++;
      if (fails) customerFailedPayments++;
      paymentCount++;

      // Only create Recovery Cases for FAILED payments
      if (fails) {
        const recoveryCase = await prisma.recoveryCase.create({
          data: {
            paymentId: payment.id,
            customerId: customer.id,
            status: 'DETECTED',
            amountAtRisk: payment.amount,
            priority: amountPaise > 200000 ? 'HIGH' : 'MEDIUM',
          }
        });
        
        recoveryCaseCount++;
        totalRevenueAtRisk += payment.amount;

        // Create initial Audit Event
        await prisma.auditEvent.create({
          data: {
            caseId: recoveryCase.id,
            eventType: 'CASE_CREATED',
            actor: 'SYSTEM',
            details: JSON.stringify({ message: 'Payment failure detected, recovery case opened' }),
          }
        });

        // Store Ground Truth Metadata
        groundTruthMetadata.push({
          caseId: recoveryCase.id,
          paymentId: payment.id,
          customerId: customer.id,
          failureCode: scenario!.code,
          expectedAction: scenario!.expectedAction,
          amount: payment.amount,
        });
      }
    }

    // Update derived aggregates as per schema
    await prisma.customer.update({
      where: { id: customer.id },
      data: {
        totalPayments: customerTotalPayments,
        failedPayments: customerFailedPayments,
      }
    });
  }

  // 4. Save Ground Truth Configuration
  const groundTruthPath = path.join(__dirname, 'groundTruth.json');
  fs.writeFileSync(groundTruthPath, JSON.stringify(groundTruthMetadata, null, 2));

  console.log('✅ Seeding complete!');
  console.log('--------------------------------------------------');
  console.log(`📊 TOTAL CUSTOMERS:       ${TOTAL_CUSTOMERS}`);
  console.log(`📊 TOTAL PAYMENTS:        ${paymentCount}`);
  console.log(`📊 RECOVERY CASES:        ${recoveryCaseCount}`);
  console.log(`📊 REVENUE AT RISK:       ₹${(totalRevenueAtRisk / 100).toFixed(2)}`);
  console.log(`📂 GROUND TRUTH SAVED TO: ${groundTruthPath}`);
  console.log('--------------------------------------------------');

}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
