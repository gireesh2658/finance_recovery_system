-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "riskTier" TEXT NOT NULL DEFAULT 'MEDIUM',
    "totalPayments" INTEGER NOT NULL DEFAULT 0,
    "failedPayments" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "externalId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "method" TEXT NOT NULL,
    "failureCode" TEXT,
    "failureReason" TEXT,
    "gatewayResponse" TEXT,
    "attemptedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Payment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RecoveryCase" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "paymentId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DETECTED',
    "amountAtRisk" INTEGER NOT NULL,
    "amountRecovered" INTEGER NOT NULL DEFAULT 0,
    "diagnosisCode" TEXT,
    "diagnosisSummary" TEXT,
    "diagnosisConfidence" REAL,
    "recommendedAction" TEXT,
    "finalOutcome" TEXT NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "nextRetryAfter" DATETIME,
    "priority" TEXT NOT NULL DEFAULT 'MEDIUM',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "resolvedAt" DATETIME,
    CONSTRAINT "RecoveryCase_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "RecoveryCase_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RecoveryAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "caseId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "actionType" TEXT NOT NULL,
    "actionInput" TEXT NOT NULL,
    "actionOutput" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "policyCheckPassed" BOOLEAN NOT NULL DEFAULT false,
    "policyCheckDetails" TEXT,
    "executionDurationMs" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RecoveryAttempt_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "RecoveryCase" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Policy" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "ruleType" TEXT NOT NULL,
    "conditions" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "AgentDecision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "caseId" TEXT NOT NULL,
    "step" TEXT NOT NULL,
    "inputContext" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "confidence" REAL,
    "modelUsed" TEXT,
    "tokenCount" INTEGER,
    "durationMs" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentDecision_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "RecoveryCase" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "caseId" TEXT,
    "attemptId" TEXT,
    "eventType" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "details" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditEvent_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "RecoveryCase" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "AuditEvent_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "RecoveryAttempt" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Customer_externalId_key" ON "Customer"("externalId");

-- CreateIndex
CREATE INDEX "Customer_email_idx" ON "Customer"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_externalId_key" ON "Payment"("externalId");

-- CreateIndex
CREATE INDEX "Payment_customerId_idx" ON "Payment"("customerId");

-- CreateIndex
CREATE INDEX "Payment_status_idx" ON "Payment"("status");

-- CreateIndex
CREATE UNIQUE INDEX "RecoveryCase_paymentId_key" ON "RecoveryCase"("paymentId");

-- CreateIndex
CREATE INDEX "RecoveryCase_customerId_idx" ON "RecoveryCase"("customerId");

-- CreateIndex
CREATE INDEX "RecoveryCase_status_idx" ON "RecoveryCase"("status");

-- CreateIndex
CREATE INDEX "RecoveryCase_priority_idx" ON "RecoveryCase"("priority");

-- CreateIndex
CREATE INDEX "RecoveryAttempt_caseId_idx" ON "RecoveryAttempt"("caseId");

-- CreateIndex
CREATE UNIQUE INDEX "RecoveryAttempt_caseId_attemptNumber_key" ON "RecoveryAttempt"("caseId", "attemptNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Policy_name_key" ON "Policy"("name");

-- CreateIndex
CREATE INDEX "Policy_isActive_priority_idx" ON "Policy"("isActive", "priority");

-- CreateIndex
CREATE INDEX "AgentDecision_caseId_idx" ON "AgentDecision"("caseId");

-- CreateIndex
CREATE INDEX "AuditEvent_caseId_createdAt_idx" ON "AuditEvent"("caseId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_attemptId_idx" ON "AuditEvent"("attemptId");
