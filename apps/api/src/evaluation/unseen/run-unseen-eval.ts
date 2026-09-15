import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import { AgentEvaluationHarness } from '../evaluator';
import { getReasonerProvider } from '../../agent/reasoner/factory';

async function runUnseenBenchmark() {
  console.log('==================================================');
  console.log('STEP 46C — UNSEEN 100-CASE BENCHMARK EXECUTION');
  console.log('==================================================\n');

  // Set the specific budget for unseen benchmark
  process.env.REAL_EVAL_MAX_LLM_CALLS = '100';

  const providerType = process.env.AI_PROVIDER ?? 'OPENROUTER';
  const model = process.env.OPENROUTER_MODEL || 'qwen2.5:7b';
  
  const unseenLabelsPath = path.join(process.cwd(), 'src/evaluation/unseen/unseen-labels.json');
  const labels = JSON.parse(fs.readFileSync(unseenLabelsPath, 'utf8'));
  const expectedCaseCount = labels.length;

  console.log('--- PRE-FLIGHT CHECK ---');
  console.log(`Provider: ${providerType}`);
  console.log(`Model: ${model}`);
  console.log(`Cases: ${expectedCaseCount}`);
  console.log(`Global LLM Budget: ${process.env.REAL_EVAL_MAX_LLM_CALLS}`);
  console.log(`Max LLM Calls Per Case: 1`);
  console.log(`Database: dev_unseen.db`);
  console.log('------------------------\n');

  if (expectedCaseCount !== 100) {
    console.error('ERROR: Unseen benchmark must have exactly 100 cases.');
    process.exit(1);
  }

  // Ensure DB points to dev_unseen.db
  if (!process.env.DATABASE_URL?.includes('dev_unseen.db')) {
    console.error(`ERROR: DATABASE_URL does not point to dev_unseen.db. It is: ${process.env.DATABASE_URL}`);
    process.exit(1);
  }

  const provider = getReasonerProvider(providerType);

  // Probe provider
  console.log('Testing provider reachability...');
  const probeResult = await provider.probe();
  if (probeResult.status !== 'AVAILABLE') {
    console.error('PROVIDER NOT READY:', probeResult.error);
    process.exit(1);
  }
  console.log('Provider READY.\n');

  // We instantiate Prisma with an explicit absolute path to avoid SQLite resolution issues
  const dbUrl = 'file:' + path.join(process.cwd(), 'prisma', 'dev_unseen.db').replace(/\\/g, '/');
  const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });
  const harness = new AgentEvaluationHarness(prisma, provider, 'REAL_LLM');

  try {
    console.log('1. Resetting database environment...');
    await harness.resetEnvironment();

    console.log(`2. Running evaluation via ${providerType} Provider on Unseen dataset...`);
    const startTime = Date.now();
    
    const result = await harness.runEvaluation(unseenLabelsPath, 100);
    
    const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\nEvaluation completed in ${durationSec} seconds.\n`);

    // 3. Print the results
    harness.printSummary(result);

    // 4. Save the results to a file for review
    const reportPath = path.join(process.cwd(), 'unseen-v1-100-raw-results.json');
    fs.writeFileSync(reportPath, JSON.stringify(result, null, 2));
    
    console.log(`\nDetailed case-by-case report saved to: ${reportPath}`);

  } catch (error) {
    console.error('Evaluation failed:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

runUnseenBenchmark();
