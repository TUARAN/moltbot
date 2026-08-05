import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AUTOFIX_MODEL_POLICY,
  assertAllowedModeSummary,
  branchSlug,
  buildAgentBootstrap,
  buildAgentContinuation,
  buildIssueFingerprint,
  extractAgentText,
  extractJsonObject,
  findOpenAutomationItem,
  flattenPaginatedItems,
  normalizeRepoRelativePath,
  parseAgentResult,
  parseReviewResult,
  sanitizePublishedTitle,
  shouldContinueAgent,
  validatePatch,
} from "../../scripts/deepseek-autofix/contracts.mjs";

function fixResult(overrides: Record<string, unknown> = {}) {
  return parseAgentResult({
    outcome: "fix-ready",
    title: "Handle empty widget payload",
    summary: "Return a typed empty result instead of throwing.",
    rootCause: "The parser dereferences the first entry before checking its length.",
    issueBody: "A focused reproduction demonstrates the empty payload crash.",
    prBody: "Summary and verification details.",
    testFiles: ["src/widgets/parser.test.ts"],
    sourceUrls: ["https://github.com/openclaw/openclaw/issues/123"],
    ...overrides,
  });
}

describe("DeepSeek autofix contracts", () => {
  it("prefers OpenCode Go and falls back to the official DeepSeek API", () => {
    expect(AUTOFIX_MODEL_POLICY).toEqual({
      primary: "opencode-go/deepseek-v4-pro",
      fallbacks: ["deepseek/deepseek-v4-pro"],
    });
  });

  it("disables workspace bootstrap creation for the automation agent", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "deepseek-autofix-config-"));
    const configPath = path.join(workspace, "openclaw.json");
    try {
      const configured = spawnSync(
        process.execPath,
        [path.join(process.cwd(), "scripts", "deepseek-autofix.mjs"), "configure", "rw"],
        {
          cwd: workspace,
          encoding: "utf8",
          env: {
            ...process.env,
            GITHUB_WORKSPACE: workspace,
            OPENCLAW_CONFIG_PATH: configPath,
          },
          stdio: "pipe",
        },
      );
      expect(configured.status).toBe(0);
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      expect(config.agents.defaults.skipBootstrap).toBe(true);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it.each([
    ["staged and present in the worktree", "staged change\n"],
    ["staged but restored in the worktree", "original\n"],
  ])("rejects an index edit %s for a no-action result", (_case, worktreeContents) => {
    const repo = mkdtempSync(path.join(tmpdir(), "deepseek-autofix-staged-"));
    const runGit = (...args: string[]) =>
      spawnSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe" });
    try {
      expect(runGit("init", "--quiet").status).toBe(0);
      writeFileSync(path.join(repo, "tracked.txt"), "original\n");
      expect(runGit("add", "tracked.txt").status).toBe(0);
      expect(
        runGit(
          "-c",
          "user.name=DeepSeek Autofix Test",
          "-c",
          "user.email=autofix-test@example.invalid",
          "commit",
          "--quiet",
          "-m",
          "baseline",
        ).status,
      ).toBe(0);

      mkdirSync(path.join(repo, ".artifacts", "deepseek-autofix"), { recursive: true });
      writeFileSync(
        path.join(repo, ".artifacts", "deepseek-autofix", "result.json"),
        `${JSON.stringify({
          outcome: "no-action",
          title: "",
          summary: "",
          rootCause: "",
          issueBody: "",
          prBody: "",
          testFiles: [],
          sourceUrls: [],
        })}\n`,
      );
      writeFileSync(path.join(repo, "tracked.txt"), "staged change\n");
      expect(runGit("add", "tracked.txt").status).toBe(0);
      writeFileSync(path.join(repo, "tracked.txt"), worktreeContents);

      const validation = spawnSync(
        process.execPath,
        [path.join(process.cwd(), "scripts", "deepseek-autofix.mjs"), "validate"],
        { cwd: repo, encoding: "utf8", stdio: "pipe" },
      );
      expect(validation.status).toBe(1);
      expect(validation.stderr).toContain("agent must leave the Git index clean");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("accepts a bounded production fix with a focused test", () => {
    const result = fixResult();
    expect(
      validatePatch({
        changedFiles: ["src/widgets/parser.ts", "src/widgets/parser.test.ts"],
        numstat: [
          { file: "src/widgets/parser.ts", added: 5, deleted: 2 },
          { file: "src/widgets/parser.test.ts", added: 12, deleted: 0 },
        ],
        result,
      }),
    ).toEqual({
      files: ["src/widgets/parser.ts", "src/widgets/parser.test.ts"],
      productionLines: 7,
    });
  });

  it.each([
    ".github/workflows/unsafe.yml",
    ".github/deepseek-autofix/agent-prompt.md",
    "scripts/deepseek-autofix.mjs",
    "src/plugin-sdk/index.ts",
    "pnpm-lock.yaml",
    "scripts/run-vitest.mjs",
  ])("rejects blocked path %s", (file) => {
    expect(() =>
      validatePatch({
        changedFiles: [file],
        numstat: [{ file, added: 1, deleted: 0 }],
        result: fixResult({ testFiles: ["test/scripts/deepseek-autofix.test.ts"] }),
      }),
    ).toThrow(/blocked path/);
  });

  it("requires a focused test for production changes", () => {
    expect(() =>
      validatePatch({
        changedFiles: ["src/widgets/parser.ts"],
        numstat: [{ file: "src/widgets/parser.ts", added: 1, deleted: 1 }],
        result: fixResult({ testFiles: [] }),
      }),
    ).toThrow(/must name at least one focused test/);
  });

  it("requires the focused regression test to be part of the patch", () => {
    expect(() =>
      validatePatch({
        changedFiles: ["src/widgets/parser.ts"],
        numstat: [{ file: "src/widgets/parser.ts", added: 1, deleted: 1 }],
        result: fixResult({ testFiles: ["src/widgets/unrelated.test.ts"] }),
      }),
    ).toThrow(/focused test must be changed/);
  });

  it("does not permit issue-only results to leave a patch", () => {
    const result = parseAgentResult({
      outcome: "issue-only",
      title: "Widget payload failure",
      summary: "The failure is reproducible but needs an owner decision.",
      rootCause: "Two public behaviors conflict.",
      issueBody: "Reproduction and evidence.",
      prBody: "",
      testFiles: [],
      sourceUrls: [],
    });
    expect(() =>
      validatePatch({
        changedFiles: ["src/widgets/parser.ts"],
        numstat: [{ file: "src/widgets/parser.ts", added: 1, deleted: 0 }],
        result,
      }),
    ).toThrow(/issue-only result must not leave workspace changes/);
  });

  it("rejects paths outside the repository", () => {
    expect(() => normalizeRepoRelativePath("../../credentials")).toThrow(/stay inside/);
    expect(() => normalizeRepoRelativePath("/tmp/credentials")).toThrow(/stay inside/);
  });

  it("rejects non-GitHub source URLs and injected automation markers", () => {
    expect(() => fixResult({ sourceUrls: ["https://example.com/report"] })).toThrow(
      /GitHub HTTPS URLs/,
    );
    expect(() => fixResult({ issueBody: "<!-- deepseek-autofix -->" })).toThrow(
      /must not contain automation markers/,
    );
  });

  it("produces stable fingerprints and safe branch slugs", () => {
    const result = fixResult();
    expect(buildIssueFingerprint(result)).toMatch(/^[a-f0-9]{64}$/);
    expect(buildIssueFingerprint(result)).toBe(buildIssueFingerprint(fixResult()));
    expect(branchSlug("Fix: Widget payload / empty value")).toBe("fix-widget-payload-empty-value");
  });

  it("neutralizes mentions and control whitespace in published titles", () => {
    expect(sanitizePublishedTitle("Fix  @openclaw/team\nnow")).toBe("Fix @\u200bopenclaw/team now");
  });

  it("keeps full agent input out of the process argument list", () => {
    const largeInput = "x".repeat(256_000);
    const bootstrap = buildAgentBootstrap(".artifacts/deepseek-autofix/main-input.md");
    expect(Buffer.byteLength(bootstrap)).toBeLessThan(1_024);
    expect(bootstrap).not.toContain(largeInput);
    expect(bootstrap).toContain("main-input.md");
  });

  it("continues an unfinished agent turn with a bounded result-file reminder", () => {
    const continuation = buildAgentContinuation(".artifacts/deepseek-autofix/result.json");
    expect(Buffer.byteLength(continuation)).toBeLessThan(1_024);
    expect(continuation).toContain("same session");
    expect(continuation).toContain("result.json");
    expect(continuation).toContain("no-action");
    expect(continuation).toContain("clean workspace");
  });

  it("continues when the agent writes an invalid intermediate result", () => {
    expect(
      shouldContinueAgent({
        result: { outcome: "issue-only", issueBody: "" },
        stagedFiles: [],
        changedFiles: [],
      }),
    ).toBe(true);
    expect(
      shouldContinueAgent({
        result: {
          outcome: "no-action",
          title: "",
          summary: "",
          rootCause: "",
          issueBody: "",
          prBody: "",
          testFiles: [],
          sourceUrls: [],
        },
        stagedFiles: [],
        changedFiles: [],
      }),
    ).toBe(false);
  });

  it("rejects executable mode changes on new and existing files", () => {
    expect(() => assertAllowedModeSummary(" create mode 100755 scripts/tool.sh")).toThrow(
      /executable files/,
    );
    expect(() =>
      assertAllowedModeSummary(" mode change 100644 => 100755 scripts/tool.sh\nnew mode 100755"),
    ).toThrow(/executable files/);
    expect(() => assertAllowedModeSummary(" create mode 100644 src/widget.ts")).not.toThrow();
  });

  it("only reuses open automation items", () => {
    const fingerprint = buildIssueFingerprint(fixResult());
    const marker = `<!-- deepseek-autofix:fingerprint=${fingerprint} -->`;
    const items = [
      { state: "closed", isPullRequest: true, body: marker, url: "closed" },
      { state: "open", isPullRequest: false, body: marker, url: "issue" },
      { state: "open", isPullRequest: true, body: marker, url: "open" },
    ];
    expect(findOpenAutomationItem(items, fingerprint, true)?.url).toBe("open");
    expect(findOpenAutomationItem(items.slice(0, 1), fingerprint, true)).toBeUndefined();
    expect(findOpenAutomationItem(items, fingerprint, false)?.url).toBe("issue");
  });

  it("flattens every paginated GitHub issue page", () => {
    expect(flattenPaginatedItems([[{ number: 1 }], [{ number: 101 }], []])).toEqual([
      { number: 1 },
      { number: 101 },
    ]);
    expect(() => flattenPaginatedItems([{ number: 1 }])).toThrow(/array of pages/);
  });

  it("extracts one unambiguous review JSON value from OpenClaw payloads", () => {
    const text = extractAgentText({
      payloads: [{ text: '```json\n{"verdict":"pass","findings":[]}\n```' }],
    });
    expect(extractJsonObject(text)).toEqual({ verdict: "pass", findings: [] });
    expect(() => extractJsonObject('Review passed: {"verdict":"pass","findings":[]}')).toThrow(
      /exactly one JSON/,
    );
    expect(
      extractJsonObject(
        'Review evidence first.\n```json\n{"verdict":"pass","findings":[]}\n```\nDone.',
      ),
    ).toEqual({ verdict: "pass", findings: [] });
    expect(() =>
      extractJsonObject(
        '```json\n{"verdict":"pass","findings":[]}\n```\n```json\n{"verdict":"fail","findings":[]}\n```',
      ),
    ).toThrow(/exactly one JSON/);
  });

  it("fails closed on malformed review results", () => {
    expect(() => parseReviewResult({ verdict: "pass" })).toThrow(/exactly/);
    expect(() => parseReviewResult({ verdict: "pass", findings: "unparsed" })).toThrow(/array/);
    expect(() =>
      parseReviewResult({
        verdict: "pass",
        findings: [
          {
            severity: "medium",
            file: "src/widget.ts",
            line: 1,
            problem: "A concrete defect.",
            requiredFix: "Correct it.",
          },
        ],
      }),
    ).toThrow(/must not contain findings/);
    expect(parseReviewResult({ verdict: "pass", findings: [] })).toEqual({
      verdict: "pass",
      findings: [],
    });
  });
});
