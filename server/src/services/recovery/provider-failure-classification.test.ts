import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  ADAPTER_FAILURE_RECOVERY_ERROR_CODES,
  INTENTIONALLY_UNCLASSIFIED_ADAPTER_FAILURE_ERROR_CODES,
  PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS,
  classifyAdapterFailureForRecovery,
} from "./service.js";

const NON_PRODUCTION_SOURCE_PATH_SEGMENTS = ["/__tests__/", ".test.ts", ".spec.ts"] as const;

const EXCLUDED_ERROR_CODE_SOURCE_FILES: ReadonlyMap<string, string> = new Map([
  [
    "packages/adapters/codex-local/src/server/acp.ts",
    "Copies auth-classifier outcomes; it does not define recovery codes.",
  ],
  ["packages/db/src/schema/heartbeat_runs.ts", "Declares the persisted errorCode column; it emits no value."],
  ["packages/db/src/schema/secret_access_events.ts", "Declares the audit errorCode column; it emits no value."],
  ["packages/db/src/schema/tool_access.ts", "Declares tool-access errorCode columns; it emits no value."],
  ["packages/shared/src/validators/issue.ts", "Declares errorCode validators; it emits no value."],
  [
    "server/src/middleware/error-handler.ts",
    "Reports exception names to telemetry, outside adapter-run recovery.",
  ],
  [
    "server/src/routes/issues.ts",
    "Emits operator-interrupt lifecycle outcomes, outside adapter-failure recovery.",
  ],
  ["server/src/services/activity.ts", "Projects stored run errorCode fields into activity views; it emits no value."],
  ["server/src/services/attention.ts", "Projects stored run errorCode fields into attention views; it emits no value."],
  ["server/src/services/external-objects.ts", "Emits external-object refresh outcomes, outside adapter-run recovery."],
  ["server/src/services/feedback.ts", "Projects stored run errorCode fields into feedback exports; it emits no value."],
  [
    "server/src/services/github-external-object-provider.ts",
    "Emits GitHub object-refresh outcomes, outside adapter-run recovery.",
  ],
  ["server/src/services/issues.ts", "Projects stored run errorCode fields into issue responses; it emits no value."],
  [
    "server/src/services/recovery/service.ts",
    "Persists recovery metadata and existing run codes; it is a consumer, not a producer.",
  ],
  [
    "server/src/services/responsible-user-denial-run-outcomes.ts",
    "Copies caller-owned denial codes onto runs, outside adapter-failure recovery.",
  ],
  ["server/src/services/secrets.ts", "Emits secret-resolution outcomes, outside adapter-run recovery."],
  [
    "server/src/services/tool-access-policy.ts",
    "Copies policy decision codes into tool-access records, outside adapter-run recovery.",
  ],
  ["server/src/services/tool-access.ts", "Persists tool-access and connection-token outcomes, outside adapter-run recovery."],
  ["server/src/services/tool-gateway.ts", "Emits tool-gateway outcomes, outside adapter-run recovery."],
]);

const NON_ADAPTER_FAILURE_ERROR_CODE_EXCLUSIONS: ReadonlyMap<string, string> = new Map([
  ["agent_not_found", "Heartbeat dispatch could not resolve an agent; this is not an adapter failure."],
  ["agent_not_invokable", "Agent lifecycle policy prevented invocation; retry requires lifecycle state to change."],
  ["agent_paused", "The agent was paused; board lifecycle owns the outcome."],
  [
    "assignment_wakeup_batched",
    "The scheduler absorbed a redundant queued assignment wake; no adapter invocation failed.",
  ],
  ["budget_blocked", "Budget policy prevented invocation; retry requires budget state to change."],
  ["cancelled", "The adapter run was deliberately cancelled; cancellation lifecycle owns the outcome."],
  ["issue_assignee_changed", "Issue ownership changed during execution; board lifecycle owns the outcome."],
  ["issue_cancelled", "The issue was cancelled; board lifecycle owns the outcome."],
  [
    "issue_continuation_waiting_on_review",
    "The issue is deliberately waiting for review, not adapter recovery.",
  ],
  ["issue_dependencies_blocked", "Issue dependencies prevent execution; dependency lifecycle owns the outcome."],
  [
    "issue_execution_lock_changed",
    "The issue execution lock changed; board concurrency control owns the outcome.",
  ],
  ["issue_not_found", "The issue disappeared before execution; board lifecycle owns the outcome."],
  ["issue_not_in_progress", "The issue is no longer executable; board lifecycle owns the outcome."],
  ["issue_paused", "The issue is paused; board lifecycle owns the outcome."],
  ["issue_reassigned", "The issue was reassigned; board lifecycle owns the outcome."],
  [
    "issue_review_participant_changed",
    "The review participant changed; review lifecycle owns the outcome.",
  ],
  ["issue_terminal_status", "The issue reached a terminal state; board lifecycle owns the outcome."],
  [
    "lock_released_on_reassignment",
    "The execution lock was released after reassignment; board lifecycle owns the outcome.",
  ],
  [
    "lease_released_before_terminal",
    "Run teardown terminalized a still-live row before releasing its lease; runtime lifecycle owns the outcome.",
  ],
  [
    "hot_restart_adopted_run_deadline",
    "The hot-restart reaper terminates the adopted process and queues its process-loss retry; runtime lifecycle owns recovery.",
  ],
  ["process_detached", "The local process detached successfully; runtime lifecycle owns the outcome."],
  ["server_shutdown_interrupted", "The server interrupted the run during shutdown; runtime lifecycle owns the outcome."],
  ["workspace_busy", "Shared-workspace contention is a scheduled deferral, not an adapter failure."],
]);

function discoverPackageSourceRoots(packagesRoot: string) {
  const sourceRoots: string[] = [];
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const entryPath = path.join(dir, entry.name);
      if (entry.name === "src") {
        sourceRoots.push(entryPath);
      } else {
        visit(entryPath);
      }
    }
  };
  visit(packagesRoot);
  return sourceRoots.sort();
}

function discoverErrorCodeSourceFiles(rootDirs: string[]) {
  const sourceFiles: string[] = [];

  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (
        entry.isFile() &&
        /\.[cm]?tsx?$/.test(entry.name) &&
        !NON_PRODUCTION_SOURCE_PATH_SEGMENTS.some((segment) => entryPath.includes(segment))
      ) {
        sourceFiles.push(entryPath);
      }
    }
  };

  for (const rootDir of rootDirs) visit(rootDir);
  return [...new Set(sourceFiles)].sort();
}

function extractEmittedErrorCodes(filePath: string) {
  const sourceText = fs.readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);
  const variableInitializers = new Map<string, ts.Expression[]>();
  const callableDeclarations = new Map<string, ts.FunctionLikeDeclaration[]>();
  const callExpressions: ts.CallExpression[] = [];
  const errorCodeAssignments: ts.Expression[] = [];

  const addInitializer = (name: string, initializer: ts.Expression) => {
    const initializers = variableInitializers.get(name) ?? [];
    initializers.push(initializer);
    variableInitializers.set(name, initializers);
  };

  const addCallableDeclaration = (name: string, declaration: ts.FunctionLikeDeclaration) => {
    const declarations = callableDeclarations.get(name) ?? [];
    declarations.push(declaration);
    callableDeclarations.set(name, declarations);
  };

  const indexSource = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      addInitializer(node.name.text, node.initializer);
      if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) {
        addCallableDeclaration(node.name.text, node.initializer);
      }
    }
    if (ts.isPropertyDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      addInitializer(node.name.text, node.initializer);
    }
    if (ts.isParameter(node) && ts.isIdentifier(node.name) && node.initializer) {
      addInitializer(node.name.text, node.initializer);
    }
    if (ts.isFunctionDeclaration(node) && node.name) {
      addCallableDeclaration(node.name.text, node);
    }
    if (ts.isCallExpression(node)) {
      callExpressions.push(node);
    }
    if (
      ts.isPropertyAssignment(node) &&
      ((ts.isIdentifier(node.name) && node.name.text === "errorCode") ||
        (ts.isStringLiteral(node.name) && node.name.text === "errorCode"))
    ) {
      errorCodeAssignments.push(node.initializer);
    }
    if (ts.isShorthandPropertyAssignment(node) && node.name.text === "errorCode") {
      errorCodeAssignments.push(node.name);
    }
    ts.forEachChild(node, indexSource);
  };
  indexSource(sourceFile);

  for (const callExpression of callExpressions) {
    let calledExpression: ts.Expression = callExpression.expression;
    while (ts.isParenthesizedExpression(calledExpression)) calledExpression = calledExpression.expression;
    if (!ts.isIdentifier(calledExpression)) continue;
    for (const declaration of callableDeclarations.get(calledExpression.text) ?? []) {
      declaration.parameters.forEach((parameter, index) => {
        if (
          ts.isIdentifier(parameter.name) &&
          parameter.name.text === "errorCode" &&
          callExpression.arguments[index]
        ) {
          addInitializer(parameter.name.text, callExpression.arguments[index]);
        }
      });
    }
  }

  const codes = new Set<string>();
  const visited = new Set<ts.Expression>();
  const collectPossibleValues = (expression: ts.Expression) => {
    if (visited.has(expression)) return;
    visited.add(expression);

    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
      if (/^[a-z][a-z0-9_]+$/.test(expression.text)) codes.add(expression.text);
      return;
    }
    if (ts.isConditionalExpression(expression)) {
      collectPossibleValues(expression.whenTrue);
      collectPossibleValues(expression.whenFalse);
      return;
    }
    if (
      ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isNonNullExpression(expression)
    ) {
      collectPossibleValues(expression.expression);
      return;
    }
    if (
      ts.isBinaryExpression(expression) &&
      (expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        expression.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    ) {
      collectPossibleValues(expression.left);
      collectPossibleValues(expression.right);
      return;
    }
    if (ts.isIdentifier(expression)) {
      for (const initializer of variableInitializers.get(expression.text) ?? []) {
        collectPossibleValues(initializer);
      }
      return;
    }
    if (ts.isPropertyAccessExpression(expression)) {
      for (const initializer of variableInitializers.get(expression.name.text) ?? []) {
        collectPossibleValues(initializer);
      }
      return;
    }
    if (ts.isCallExpression(expression)) {
      let calledExpression: ts.Expression = expression.expression;
      while (ts.isParenthesizedExpression(calledExpression)) calledExpression = calledExpression.expression;
      if (ts.isArrowFunction(calledExpression) || ts.isFunctionExpression(calledExpression)) {
        const collectReturns = (node: ts.Node) => {
          if (ts.isReturnStatement(node) && node.expression) {
            collectPossibleValues(node.expression);
            return;
          }
          if (node !== calledExpression && ts.isFunctionLike(node)) return;
          ts.forEachChild(node, collectReturns);
        };
        collectReturns(calledExpression.body);
      }
    }
  };

  for (const expression of errorCodeAssignments) collectPossibleValues(expression);
  return { codes, errorCodeAssignmentCount: errorCodeAssignments.length };
}

describe("classifyAdapterFailureForRecovery", () => {
  it("extracts error codes sourced from parameter defaults and same-file call arguments", () => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-error-code-extractor-"));
    const fixturePath = path.join(fixtureDir, "fixture.ts");
    fs.writeFileSync(
      fixturePath,
      `
        function emit(errorCode = "default_parameter_code") {
          return { errorCode };
        }
        const emitFromArrow = (errorCode = "arrow_default_code") => ({ errorCode });
        emit("function_argument_code");
        emitFromArrow("arrow_argument_code");
      `,
    );

    try {
      expect(extractEmittedErrorCodes(fixturePath).codes).toEqual(
        new Set([
          "default_parameter_code",
          "function_argument_code",
          "arrow_default_code",
          "arrow_argument_code",
        ]),
      );
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it("classifies usage-limit messages and parses the provider reset time", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "You've hit your usage limit for GPT-5. Try again at 4:30 PM (America/Chicago).",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-07-15T21:30:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("uses the default recovery backoff when quota reset time is absent", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "Provider quota exceeded for this model.",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date(now.getTime() + PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS),
      parsedResetTime: false,
    });
  });

  it("treats timezone-less provider reset clocks as UTC", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "You've hit your usage limit. Try again at 4:30 PM.",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-07-16T16:30:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("parses provider reset clocks in 24-hour format", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "You've hit your usage limit. Try again at 21:30 (UTC).",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-07-15T21:30:00.000Z"),
      parsedResetTime: true,
    });
  });

  it.each([
    "model_not_found: requested model does not exist",
    "No API credentials were found for this provider",
    "API key is not set",
  ])("classifies configuration failures: %s", (error) => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error,
      resultJson: null,
    })).toEqual({ kind: "configuration_incomplete" });
  });

  it("ignores quota-like text from non-adapter failures", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "timeout",
      error: "Provider quota exceeded while waiting for a downstream service.",
      resultJson: null,
    })).toBeNull();
  });

  it("does not treat a generic capacity limit as provider quota", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "Workspace storage capacity limit reached.",
      resultJson: null,
    })).toBeNull();
  });

  it.each([
    "You've hit your session limit",
    "You've hit your weekly limit",
    "Weekly limit reached",
    "You've hit your monthly spend limit",
  ])("classifies live quota vocabulary with a positive control: %s", (error) => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error,
      resultJson: null,
    })?.kind).toBe("provider_quota");

    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "You've hit your usage limit",
      resultJson: null,
    })?.kind).toBe("provider_quota");

    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "Workspace storage capacity limit reached.",
      resultJson: null,
    })).toBeNull();
  });

  it.each(["acpx_turn_failed", "process_lost"])(
    "classifies live failure code %s with two-sided controls",
    (errorCode) => {
      expect(classifyAdapterFailureForRecovery({
        errorCode,
        error: "synthetic emitted transient failure",
        resultJson: null,
      })).toEqual({ kind: "transient_infra" });

      expect(classifyAdapterFailureForRecovery({
        errorCode: "adapter_failed",
        error: "You've hit your usage limit",
        resultJson: null,
      })?.kind).toBe("provider_quota");

      expect(classifyAdapterFailureForRecovery({
        errorCode: "timeout",
        error: "synthetic emitted transient failure",
        resultJson: null,
      })).toBeNull();
    },
  );

  it("classifies the emitted quota and transient retry families", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "acpx_turn_failed",
      error: "You've hit your monthly spend limit · raise it at claude.ai/settings/usage",
      resultJson: null,
    })?.kind).toBe("provider_quota");

    for (const errorCode of [
      "acpx_turn_failed",
      "acpx_session_init_failed",
      "paperclip_control_plane_unreachable",
      "process_lost",
    ]) {
      expect(classifyAdapterFailureForRecovery({
        errorCode,
        error: "synthetic emitted transient failure",
        resultJson: null,
      })).toEqual({ kind: "transient_infra" });
    }
  });

  it("explicitly excludes runtime-owned adopted-run deadline recovery", () => {
    expect(NON_ADAPTER_FAILURE_ERROR_CODE_EXCLUSIONS.get("hot_restart_adopted_run_deadline"))
      .toContain("runtime lifecycle owns recovery");
    expect(classifyAdapterFailureForRecovery({
      errorCode: "hot_restart_adopted_run_deadline",
      error: "Hot-restart adopted run exceeded its absolute post-adoption deadline",
      resultJson: null,
    })).toBeNull();
  });

  it("parses the Codex quota grammar with ordinal day, no timezone (defaults to UTC)", () => {
    const now = new Date("2026-08-17T17:58:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "provider_quota",
      error: "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Aug 20th, 2026 6:54 AM.",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-08-20T06:54:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("still parses the Claude weekly-limit grammar (non-regression control)", () => {
    const now = new Date("2026-07-10T12:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "You've hit your weekly limit. Your limit resets Jul 14 at 3:00pm (America/New_York).",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-07-14T19:00:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("returns parsedResetTime: false for unrecognised quota grammars (negative control)", () => {
    const now = new Date("2026-08-17T18:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "provider_quota",
      error: "You've hit your usage limit. Please wait until quota refreshes.",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date(now.getTime() + PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS),
      parsedResetTime: false,
    });
  });

  it("applies multiplicative backoff for consecutive unparsed quota failures", () => {
    const now = new Date("2026-08-17T18:00:00.000Z");
    const run = {
      errorCode: "provider_quota" as const,
      error: "You've hit your usage limit. Please wait.",
      resultJson: null,
    };

    const c0 = classifyAdapterFailureForRecovery(run, now, { consecutiveUnparsedQuotaFailures: 0 });
    const c1 = classifyAdapterFailureForRecovery(run, now, { consecutiveUnparsedQuotaFailures: 1 });
    const c2 = classifyAdapterFailureForRecovery(run, now, { consecutiveUnparsedQuotaFailures: 2 });
    const c3 = classifyAdapterFailureForRecovery(run, now, { consecutiveUnparsedQuotaFailures: 3 });

    expect(c0).toMatchObject({ kind: "provider_quota", parsedResetTime: false });
    expect(c1).toMatchObject({ kind: "provider_quota", parsedResetTime: false });
    expect(c2).toMatchObject({ kind: "provider_quota", parsedResetTime: false });
    expect(c3).toMatchObject({ kind: "provider_quota", parsedResetTime: false });

    const retryAt0 = (c0 as { retryAt: Date }).retryAt.getTime();
    const retryAt1 = (c1 as { retryAt: Date }).retryAt.getTime();
    const retryAt2 = (c2 as { retryAt: Date }).retryAt.getTime();
    const retryAt3 = (c3 as { retryAt: Date }).retryAt.getTime();

    expect(retryAt0).toBe(now.getTime() + PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS);
    expect(retryAt1).toBe(now.getTime() + PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS * 2);
    expect(retryAt2).toBe(now.getTime() + PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS * 4);
    expect(retryAt3).toBe(now.getTime() + PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS * 8);
  });

  it("caps multiplicative backoff at 2^4 (16h)", () => {
    const now = new Date("2026-08-17T18:00:00.000Z");
    const c4 = classifyAdapterFailureForRecovery({
      errorCode: "provider_quota",
      error: "You've hit your usage limit.",
      resultJson: null,
    }, now, { consecutiveUnparsedQuotaFailures: 4 });
    const c10 = classifyAdapterFailureForRecovery({
      errorCode: "provider_quota",
      error: "You've hit your usage limit.",
      resultJson: null,
    }, now, { consecutiveUnparsedQuotaFailures: 10 });

    expect((c4 as { retryAt: Date }).retryAt.getTime())
      .toBe(now.getTime() + PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS * 16);
    expect((c10 as { retryAt: Date }).retryAt.getTime())
      .toBe(now.getTime() + PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS * 16);
  });

  it("does not apply multiplicative backoff when reset time is parsed", () => {
    const now = new Date("2026-08-17T17:58:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "provider_quota",
      error: "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Aug 20th, 2026 6:54 AM.",
      resultJson: null,
    }, now, { consecutiveUnparsedQuotaFailures: 5 });

    expect(classification).toMatchObject({
      kind: "provider_quota",
      parsedResetTime: true,
      retryAt: new Date("2026-08-20T06:54:00.000Z"),
    });
  });

  it("source-derives emitted failure codes and requires classification or explicit exclusion", () => {
    const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
    const packageSourceRoots = discoverPackageSourceRoots(path.join(repoRoot, "packages"));
    const sourceFiles = discoverErrorCodeSourceFiles([
      path.join(repoRoot, "server/src"),
      ...packageSourceRoots,
    ]);
    const discoveredProducerPaths = new Set(
      sourceFiles
        .filter((filePath) => extractEmittedErrorCodes(filePath).errorCodeAssignmentCount > 0)
        .map((filePath) => path.relative(repoRoot, filePath)),
    );
    for (const excludedPath of EXCLUDED_ERROR_CODE_SOURCE_FILES.keys()) {
      expect(discoveredProducerPaths, `${excludedPath} exclusion must name a discovered errorCode source`).toContain(
        excludedPath,
      );
    }
    const producerFiles = sourceFiles.filter((filePath) => {
      if (extractEmittedErrorCodes(filePath).errorCodeAssignmentCount === 0) return false;
      return !EXCLUDED_ERROR_CODE_SOURCE_FILES.has(path.relative(repoRoot, filePath));
    });

    expect(producerFiles.length, "adapter errorCode producer discovery must not be empty").toBeGreaterThan(0);
    const derivedCodes = new Set<string>();
    for (const filePath of producerFiles) {
      const { codes } = extractEmittedErrorCodes(filePath);
      expect(codes.size, `${path.relative(repoRoot, filePath)} must yield at least one error code`).toBeGreaterThan(0);
      for (const code of codes) derivedCodes.add(code);
    }

    expect(derivedCodes.size).toBeGreaterThan(0);
    for (const excludedCode of NON_ADAPTER_FAILURE_ERROR_CODE_EXCLUSIONS.keys()) {
      expect(derivedCodes, `${excludedCode} exclusion must name a derived error code`).toContain(excludedCode);
    }
    for (const errorCode of derivedCodes) {
      if (NON_ADAPTER_FAILURE_ERROR_CODE_EXCLUSIONS.has(errorCode)) continue;
      expect(
        ADAPTER_FAILURE_RECOVERY_ERROR_CODES.has(errorCode) ||
          INTENTIONALLY_UNCLASSIFIED_ADAPTER_FAILURE_ERROR_CODES.has(errorCode),
        `${errorCode} must be classified or intentionally excluded`,
      ).toBe(true);
    }
  });
});
