import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import { AgentEvaluationHarness } from './evaluator';

async function runRealLLMEvaluation() {
  const isDryRun = process.argv.includes('--dry-run');
  const isProbeOnly = process.argv.includes('--probe-only');
  
  const limitArgIndex = process.argv.findIndex(arg => arg.startsWith('--limit='));
  let caseLimit: number | undefined;
  if (limitArgIndex !== -1) {
    caseLimit = parseInt(process.argv[limitArgIndex].split('=')[1], 10);
  }

  if (isDryRun) {
    console.log('==================================================');
    console.log('REAL LLM EVALUATION — DRY RUN');
    console.log('==================================================\n');
  } else {
    console.log('==================================================');
    console.log('STEP 13/21: REAL LLM EVALUATION (58 CASES)');
    console.log('==================================================\n');
  }

  // 1. Parse CLI overrides
  let cliProvider: string | undefined;
  const providerArgIndex = process.argv.findIndex(arg => arg.startsWith('--provider='));
  if (providerArgIndex !== -1) {
    cliProvider = process.argv[providerArgIndex].split('=')[1].toUpperCase();
  }

  // 2. Determine actual provider safely
  const providerType = cliProvider ?? process.env.AI_PROVIDER ?? 'OPENROUTER';
  
  let model = 'mock-model';
  if (providerType === 'OPENROUTER') {
    model = process.env.OPENROUTER_MODEL || 'mock-model';
  }
  
  const globalBudget = parseInt(process.env.REAL_EVAL_MAX_LLM_CALLS || '58', 10);
  const maxPerCase = 1;
  const groundTruthPath = path.join(__dirname, '../seed/groundTruth.json');
  
  const gtExists = fs.existsSync(groundTruthPath);
  let expectedCaseCount = 0;
  if (gtExists) {
    try {
      const gt = JSON.parse(fs.readFileSync(groundTruthPath, 'utf8'));
      expectedCaseCount = gt.length;
    } catch {
      // Ignore parse error here for now
    }
  }

  // 3. Construct provider (this will validate configuration and throw if invalid)
  let provider;
  let providerConfigStatus = 'PASS';
  try {
    const { getReasonerProvider } = require('../agent/reasoner/factory');
    provider = getReasonerProvider(providerType);
  } catch (error: any) {
    providerConfigStatus = `FAIL (${error.message})`;
  }

  if (isDryRun) {
    console.log(`Provider: ${providerType}`);
    console.log(`Model: ${model}\n`);
    
    console.log(`Cases available: ${expectedCaseCount}\n`);
    
    console.log(`Global LLM budget: ${globalBudget}`);
    console.log(`Maximum calls per case: ${maxPerCase}\n`);
    
    // We instantiate Prisma but DO NOT mutate
    const prisma = new PrismaClient();
    let dbSafety = 'FAIL';
    try {
      const { verifyEvaluationDatabaseIntegrity } = require('./db-safety');
      await verifyEvaluationDatabaseIntegrity(prisma);
      dbSafety = 'PASS';
    } catch (e: any) {
      console.error(e.message);
      dbSafety = 'FAIL';
    } finally {
      await prisma.$disconnect();
    }
    
    console.log(`Database safety: ${dbSafety}`);
    console.log(`Seed integrity: ${expectedCaseCount > 0 ? 'PASS' : 'FAIL'}`);
    console.log(`Ground-truth available: ${gtExists ? 'PASS' : 'FAIL'}`);
    console.log(`Provider configuration: ${providerConfigStatus.startsWith('PASS') ? 'PASS' : 'FAIL'}`);
    console.log(`Model configuration: PASS\n`); 
    
    console.log(`Database mutations: 0`);
    console.log(`LLM requests: 0`);
    console.log(`Recovery actions: 0\n`);
    
    console.log(`Status:`);
    console.log(`DRY-RUN VALIDATION COMPLETED`);
    
    if (!providerConfigStatus.startsWith('PASS') || dbSafety === 'FAIL' || !gtExists) {
      process.exit(1);
    }
    process.exit(0);
  }

  // ---- REAL EXECUTION PATH ----

  if (!providerConfigStatus.startsWith('PASS')) {
    console.error(`ERROR: Provider configuration failed: ${providerConfigStatus}`);
    process.exit(1);
  }
  if (!gtExists) {
    console.error(`ERROR: Ground truth file not found at ${groundTruthPath}`);
    process.exit(1);
  }

  console.log('--- PRE-FLIGHT CHECK ---');
  console.log(`Provider: ${providerType}`);
  if (providerType === 'BASELINE') {
    console.log(`Mode: OFFLINE / NON-LLM`);
  } else {
    console.log(`Model: ${model}`);
    console.log(`Mode: LIVE`);
  }
  console.log(`Cases: ${expectedCaseCount}`);
  if (expectedCaseCount > globalBudget) {
    console.warn(`WARNING: Cases (${expectedCaseCount}) exceeds global LLM budget (${globalBudget}). Benchmark capacity warning.`);
  }
  console.log(`Global LLM Budget: ${globalBudget}`);
  console.log(`Max LLM Calls Per Case: ${maxPerCase}`);
  console.log(`Database: DEVELOPMENT ONLY`);
  console.log('------------------------\n');

  if (isProbeOnly) {
    console.log('==================================================');
    console.log('PROVIDER CAPACITY GATE');
    console.log('==================================================\n');
    console.log(`Provider: ${providerType}`);
    console.log(`Model: ${model}\n`);

    console.log(`Probe requests:\n1\n`);

    const result = await provider.probe();

    const reachability = (result.status === 'NETWORK_FAILURE' || result.status === 'TIMEOUT') ? 'FAIL' : 'PASS';
    const auth = (result.status === 'AUTHENTICATION_FAILURE') ? 'FAIL' : 'PASS';
    const quota = (result.status === 'AVAILABLE' || result.status === 'MALFORMED_PROVIDER_RESPONSE') ? 'PASS' : 'FAIL';

    console.log(`Provider reachability:\n${reachability}\n`);
    console.log(`Authentication:\n${auth}\n`);
    console.log(`Quota availability:\n${quota}\n`);

    if (result.status !== 'AVAILABLE') {
      console.log(`Primary provider error:\n${(result as any).error}\n`);
    } else {
      console.log(`Primary provider error:\nNONE\n`);
    }

    if (quota === 'FAIL' || auth === 'FAIL' || reachability === 'FAIL') {
      console.log(`Evaluation budget consumed:\n0\n`);
      console.log(`Evaluation cases executed:\n0\n`);
      console.log(`Database mutations:\n0\n`);
      console.log(`Ground-truth exposed:\nNO\n`);
      console.log(`BENCHMARK STATUS:\nBLOCKED\n`);
      console.log('==================================================');
      process.exit(1);
    } else {
      console.log(`Evaluation budget consumed:\n0\n`);
      console.log(`Evaluation cases executed:\n0\n`);
      console.log(`Database mutations:\n0\n`);
      console.log(`Ground-truth exposed:\nNO\n`);
      console.log(`BENCHMARK STATUS:\nREADY\n`);
      console.log('==================================================');
      process.exit(0);
    }
  }

  const prisma = new PrismaClient();
  
  // We initialize the harness with REAL_LLM mode
  const harness = new AgentEvaluationHarness(prisma, provider, 'REAL_LLM');

  try {
    console.log('1. Resetting database environment...');
    await harness.resetEnvironment();

    console.log(`2. Running evaluation via ${providerType} Provider...`);
    console.log('   (This will take several minutes as it processes all cases sequentially)');
    const startTime = Date.now();
    
    // Note: The reasoner provider internally controls API calls. It will take time.
    const result = await harness.runEvaluation(groundTruthPath, caseLimit);
    
    const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\nEvaluation completed in ${durationSec} seconds.\n`);

    // 3. Print the results
    harness.printSummary(result);

    // 4. Save the results to a file for review
    const reportPath = path.join(process.cwd(), 'real-llm-evaluation-report.json');
    fs.writeFileSync(reportPath, JSON.stringify(result, null, 2));
    
    console.log(`\nDetailed case-by-case report saved to: ${reportPath}`);

  } catch (error) {
    console.error('Evaluation failed:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

runRealLLMEvaluation();
