#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  AUTOFIX_MARKER,
  AUTOFIX_MODEL_POLICY,
  DEFAULT_POLICY,
  UPSTREAM_SYNC_MARKER,
  assertAllowedModeSummary,
  branchSlug,
  buildAgentBootstrap,
  buildAgentContinuation,
  buildIssueFingerprint,
  extractAgentText,
  extractJsonObject,
  findOpenAutomationItem,
  flattenPaginatedItems,
  parseAgentResult,
  parseReviewResult,
  sanitizePublishedTitle,
  validatePatch,
} from "./deepseek-autofix/contracts.mjs";

const ROOT = process.cwd();
const TRUSTED_ROOT = process.env.DEEPSEEK_AUTOFIX_TRUSTED_ROOT || ROOT;
const RUNTIME_ROOT = process.env.DEEPSEEK_AUTOFIX_RUNTIME_ROOT || ROOT;
const ARTIFACT_DIR = path.join(ROOT, ".artifacts", "deepseek-autofix");
const CONTEXT_PATH = path.join(ARTIFACT_DIR, "context.json");
const RESULT_PATH = path.join(ARTIFACT_DIR, "result.json");
const REVIEW_PATH = path.join(ARTIFACT_DIR, "review.json");
const BUNDLE_DIR = path.join(ARTIFACT_DIR, "bundle");
const PATCH_PATH = path.join(BUNDLE_DIR, "changes.patch");
const MANIFEST_PATH = path.join(BUNDLE_DIR, "manifest.json");
const VERIFY_IMAGE = "deepseek-autofix-verify:node24";
const MAX_AGENT_TURNS = 3;
// Three repair turns plus one review turn must leave time inside the 75-minute Actions job.
const AGENT_TURN_TIMEOUT_SECONDS = 15 * 60;

function fail(message) {
  throw new Error(message);
}

function ensureArtifactDir() {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    encoding: "utf8",
    env: options.env ?? process.env,
    maxBuffer: 32 * 1024 * 1024,
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    fail(`${command} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    fail(`${command} exited ${result.status}${detail ? `\n${detail}` : ""}`);
  }
  return options.inherit ? "" : result.stdout.trim();
}

function ghJson(args) {
  const output = run("gh", args);
  return output ? JSON.parse(output) : null;
}

function listRepositoryIssues(repository, state = "all") {
  const pages = ghJson([
    "api",
    "--paginate",
    "--slurp",
    `repos/${repository}/issues?state=${state}&per_page=100`,
  ]);
  return flattenPaginatedItems(pages ?? []);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function requireForkRepository() {
  const repository = process.env.GITHUB_REPOSITORY || DEFAULT_POLICY.forkRepository;
  if (repository.toLowerCase() !== DEFAULT_POLICY.forkRepository.toLowerCase()) {
    fail(`deepseek autofix is fork-only; refusing to run in ${repository}`);
  }
  return repository;
}

function trimText(value, limit = 4_000) {
  const text = typeof value === "string" ? value : "";
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[truncated]`;
}

function listAutomationItems(repository) {
  return listRepositoryIssues(repository)
    .filter(
      (item) =>
        typeof item.body === "string" &&
        item.body.includes(AUTOFIX_MARKER) &&
        !item.body.includes(UPSTREAM_SYNC_MARKER),
    )
    .map((item) => ({
      number: item.number,
      title: item.title,
      url: item.html_url,
      state: item.state,
      createdAt: item.created_at,
      updatedAt: item.updated_at,
      isPullRequest: Boolean(item.pull_request),
      body: trimText(item.body, 6_000),
    }));
}

function prepare() {
  const repository = requireForkRepository();
  ensureArtifactDir();
  const baseSha = run("git", ["rev-parse", "HEAD"]);
  const upstreamSha = run("git", [
    "ls-remote",
    `https://github.com/${DEFAULT_POLICY.upstreamRepository}.git`,
    "refs/heads/main",
  ]).split(/\s+/)[0];
  const upstreamIssues = ghJson([
    "issue",
    "list",
    "--repo",
    DEFAULT_POLICY.upstreamRepository,
    "--state",
    "open",
    "--limit",
    "30",
    "--search",
    "sort:updated-desc label:bug",
    "--json",
    "number,title,body,labels,url,updatedAt",
  ]).map((issue) => Object.assign(issue, { body: trimText(issue.body) }));
  const upstreamCommits = (
    ghJson(["api", `repos/${DEFAULT_POLICY.upstreamRepository}/commits?sha=main&per_page=20`]) ?? []
  ).map((entry) => ({
    sha: entry.sha,
    url: entry.html_url,
    message: trimText(entry.commit?.message, 1_000),
  }));
  const context = {
    generatedAt: new Date().toISOString(),
    forkRepository: repository,
    upstreamRepository: DEFAULT_POLICY.upstreamRepository,
    baseSha,
    upstreamSha,
    policy: DEFAULT_POLICY,
    existingAutomationItems: listAutomationItems(repository),
    upstreamIssues,
    upstreamCommits,
  };
  writeJson(CONTEXT_PATH, context);
  console.log(`Prepared DeepSeek context at ${path.relative(ROOT, CONTEXT_PATH)}.`);
}

function configure(access) {
  if (access !== "rw" && access !== "ro") {
    fail("configure requires workspace access rw or ro");
  }
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  if (!configPath) {
    fail("OPENCLAW_CONFIG_PATH is required");
  }
  const workspace = process.env.GITHUB_WORKSPACE || ROOT;
  const agentId = access === "ro" ? "reviewer" : "main";
  writeJson(configPath, {
    agents: {
      defaults: {
        workspace,
        model: {
          primary: AUTOFIX_MODEL_POLICY.primary,
          fallbacks: [...AUTOFIX_MODEL_POLICY.fallbacks],
        },
        thinkingDefault: "high",
        sandbox: {
          mode: "all",
          backend: "docker",
          scope: "session",
          workspaceAccess: access,
          docker: {
            image: "openclaw-sandbox:bookworm-slim",
            network: "none",
            readOnlyRoot: true,
            capDrop: ["ALL"],
            user: `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
            env: { LANG: "C.UTF-8" },
          },
        },
      },
      list: [{ id: agentId, default: true, workspace }],
    },
    tools: {
      profile: "coding",
      deny: [
        "group:web",
        "group:sessions",
        "group:memory",
        "group:media",
        "group:automation",
        "group:messaging",
        "group:ui",
        "group:nodes",
        "group:agents",
        "group:plugins",
      ],
    },
  });
  console.log(`Configured sandboxed OpenClaw agent with ${access} workspace access.`);
}

function runAgentTurn(message, agentId) {
  const runId = process.env.GITHUB_RUN_ID || "local";
  const output = run(
    "node",
    [
      path.join(RUNTIME_ROOT, "openclaw.mjs"),
      "agent",
      "--local",
      "--agent",
      agentId,
      "--session-key",
      `agent:${agentId}:deepseek-autofix-${runId}`,
      "--thinking",
      "high",
      "--timeout",
      String(AGENT_TURN_TIMEOUT_SECONDS),
      "--json",
      "--message",
      message,
    ],
    // Provider credentials stay in a runtime checkout that the repair workspace cannot modify.
    { cwd: RUNTIME_ROOT },
  );
  return JSON.parse(output);
}

function invokeAgent(message, agentId) {
  const inputFile = `.artifacts/deepseek-autofix/${agentId}-input.md`;
  writeFileSync(path.join(ROOT, inputFile), `${message}\n`, "utf8");
  return runAgentTurn(buildAgentBootstrap(inputFile), agentId);
}

function agentNeedsContinuation() {
  if (!existsSync(RESULT_PATH)) {
    return true;
  }
  const result = parseAgentResult(readJson(RESULT_PATH));
  if (stagedFiles().length > 0) {
    return true;
  }
  return result.outcome !== "fix-ready" && changedFiles().length > 0;
}

function runAgent() {
  if (!existsSync(CONTEXT_PATH)) {
    fail(`missing context: ${CONTEXT_PATH}`);
  }
  const promptPath = path.join(TRUSTED_ROOT, ".github", "deepseek-autofix", "agent-prompt.md");
  const prompt = readFileSync(promptPath, "utf8");
  const context = readFileSync(CONTEXT_PATH, "utf8");
  const message = `${prompt}\n\n<untrusted_context_json>\n${context}\n</untrusted_context_json>`;
  let response = invokeAgent(message, "main");
  writeJson(path.join(ARTIFACT_DIR, "agent-response-1.json"), response);
  for (let turn = 2; turn <= MAX_AGENT_TURNS && agentNeedsContinuation(); turn += 1) {
    console.log(
      `DeepSeek agent has not produced a policy-complete result; continuing turn ${turn}.`,
    );
    response = runAgentTurn(buildAgentContinuation(path.relative(ROOT, RESULT_PATH)), "main");
    writeJson(path.join(ARTIFACT_DIR, `agent-response-${turn}.json`), response);
  }
  writeJson(path.join(ARTIFACT_DIR, "agent-response.json"), response);
  if (!existsSync(RESULT_PATH)) {
    fail(`agent did not write ${path.relative(ROOT, RESULT_PATH)}`);
  }
  parseAgentResult(readJson(RESULT_PATH));
  console.log("DeepSeek agent produced a schema-valid result.");
}

function prepareUntrackedFilesForDiff() {
  const untracked = run("git", ["ls-files", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter(
      (file) => file && !file.startsWith(".artifacts/") && !file.startsWith(".codex-worktrees/"),
    );
  if (untracked.length > 0) {
    run("git", ["add", "--intent-to-add", "--", ...untracked]);
  }
}

function changedFiles() {
  prepareUntrackedFilesForDiff();
  return run("git", [
    "diff",
    "--name-only",
    "--",
    ".",
    ":(exclude).artifacts/**",
    ":(exclude).codex-worktrees/**",
  ])
    .split("\n")
    .filter(Boolean);
}

function stagedFiles() {
  return run("git", [
    "diff",
    "--cached",
    "--name-only",
    "--",
    ".",
    ":(exclude).artifacts/**",
    ":(exclude).codex-worktrees/**",
  ])
    .split("\n")
    .filter(Boolean);
}

function diffNumstat() {
  return run("git", [
    "diff",
    "--numstat",
    "--",
    ".",
    ":(exclude).artifacts/**",
    ":(exclude).codex-worktrees/**",
  ])
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [added, deleted, ...fileParts] = line.split("\t");
      if (added === "-" || deleted === "-") {
        fail(`binary changes are not allowed: ${fileParts.join("\t")}`);
      }
      return { added: Number(added), deleted: Number(deleted), file: fileParts.join("\t") };
    });
}

function validate() {
  const result = parseAgentResult(readJson(RESULT_PATH));
  const staged = stagedFiles();
  if (staged.length > 0) {
    fail(`agent must leave the Git index clean: ${staged.join(", ")}`);
  }
  const modeSummary = run("git", [
    "diff",
    "--summary",
    "--",
    ".",
    ":(exclude).artifacts/**",
    ":(exclude).codex-worktrees/**",
  ]);
  assertAllowedModeSummary(modeSummary);
  const validation = validatePatch({
    changedFiles: changedFiles(),
    numstat: diffNumstat(),
    result,
  });
  writeJson(path.join(ARTIFACT_DIR, "validation.json"), validation);
  console.log(
    `Validated ${validation.files.length} changed files and ${validation.productionLines} production lines.`,
  );
  return validation;
}

function review() {
  const result = parseAgentResult(readJson(RESULT_PATH));
  if (result.outcome !== "fix-ready") {
    writeJson(REVIEW_PATH, { verdict: "not-required", findings: [] });
    return;
  }
  const reviewPrompt = readFileSync(
    path.join(TRUSTED_ROOT, ".github", "deepseek-autofix", "review-prompt.md"),
    "utf8",
  );
  const diff = run("git", [
    "diff",
    "--",
    ".",
    ":(exclude).artifacts/**",
    ":(exclude).codex-worktrees/**",
  ]);
  const response = invokeAgent(
    `${reviewPrompt}\n\n<claimed_result_json>\n${JSON.stringify(result)}\n</claimed_result_json>\n\n<untrusted_patch>\n${diff}\n</untrusted_patch>`,
    "reviewer",
  );
  writeJson(path.join(ARTIFACT_DIR, "review-response.json"), response);
  const reviewResult = parseReviewResult(extractJsonObject(extractAgentText(response)));
  if (reviewResult.verdict !== "pass") {
    writeJson(REVIEW_PATH, reviewResult);
    fail(
      `independent DeepSeek review rejected the patch with ${reviewResult.findings.length} finding(s)`,
    );
  }
  writeJson(REVIEW_PATH, reviewResult);
  console.log("Independent DeepSeek review passed.");
}

function verify() {
  const result = parseAgentResult(readJson(RESULT_PATH));
  if (result.outcome !== "fix-ready") {
    return;
  }
  run("git", ["diff", "--check"]);
  const files = changedFiles();
  const formattable = files.filter((file) =>
    /\.(?:[cm]?[jt]sx?|json|json5|ya?ml|md|mdx|css|scss|html)$/.test(file),
  );
  if (formattable.length > 0) {
    // The candidate checkout is intentionally read-only during verification. Invoking pnpm here
    // can trigger its dependency-status install path, which writes a probe beside package.json.
    runVerificationCommand(["node_modules/.bin/oxfmt", "--check", "--threads=1", ...formattable]);
  }
  if (result.testFiles.length > 0) {
    runVerificationCommand(["node", "scripts/run-vitest.mjs", ...result.testFiles]);
  }
  console.log("Deterministic patch verification passed.");
}

function runVerificationCommand(command) {
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  run(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--user",
      `${uid}:${gid}`,
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,noexec",
      "--env",
      "CI=true",
      "--env",
      "HOME=/tmp",
      "--env",
      "COREPACK_ENABLE_DOWNLOAD_PROMPT=0",
      "--env",
      "OPENCLAW_VITEST_FS_MODULE_CACHE_PATH=/tmp/openclaw-vitest-cache",
      "--volume",
      `${ROOT}:/workspace:ro`,
      "--workdir",
      "/workspace",
      VERIFY_IMAGE,
      ...command,
    ],
    { inherit: true },
  );
}

function packageBundle() {
  const context = readJson(CONTEXT_PATH);
  const result = parseAgentResult(readJson(RESULT_PATH));
  const reviewResult = readJson(REVIEW_PATH);
  mkdirSync(BUNDLE_DIR, { recursive: true });
  const patch = run("git", [
    "diff",
    "--binary",
    "--",
    ".",
    ":(exclude).artifacts/**",
    ":(exclude).codex-worktrees/**",
  ]);
  writeFileSync(PATCH_PATH, patch ? `${patch}\n` : "", "utf8");
  const fingerprint = buildIssueFingerprint(result);
  writeJson(MANIFEST_PATH, {
    version: 1,
    generatedAt: new Date().toISOString(),
    baseSha: context.baseSha,
    upstreamSha: context.upstreamSha,
    result,
    review: reviewResult,
    fingerprint,
    patchSha256: createHash("sha256").update(readFileSync(PATCH_PATH)).digest("hex"),
  });
  console.log(`Packaged ${result.outcome} bundle with fingerprint ${fingerprint.slice(0, 12)}.`);
}

function automationItemFingerprint(body) {
  return body?.match(/<!-- deepseek-autofix:fingerprint=([a-f0-9]{64}) -->/)?.[1];
}

function neutralizeMentions(text) {
  return text.replaceAll("@", "@\u200b");
}

function upsertIssue({ repository, title, body, fingerprint, marker = AUTOFIX_MARKER }) {
  const items = listRepositoryIssues(repository, "open");
  const existing = items.find(
    (item) => !item.pull_request && automationItemFingerprint(item.body) === fingerprint,
  );
  const fullBody = `${marker}\n<!-- deepseek-autofix:fingerprint=${fingerprint} -->\n\n${neutralizeMentions(body)}`;
  const safeTitle = sanitizePublishedTitle(title);
  if (existing) {
    ghJson([
      "api",
      "-X",
      "PATCH",
      `repos/${repository}/issues/${existing.number}`,
      "-f",
      `title=${safeTitle}`,
      "-f",
      `body=${fullBody}`,
    ]);
    return existing.number;
  }
  const created = ghJson([
    "api",
    "-X",
    "POST",
    `repos/${repository}/issues`,
    "-f",
    `title=${safeTitle}`,
    "-f",
    `body=${fullBody}`,
  ]);
  return created.number;
}

function recentAutomationCounts(repository) {
  const since = Date.now() - 24 * 60 * 60 * 1_000;
  const items = listAutomationItems(repository);
  return {
    newIssues: items.filter((item) => !item.isPullRequest && Date.parse(item.createdAt) >= since)
      .length,
    newPullRequests: items.filter(
      (item) => item.isPullRequest && Date.parse(item.createdAt) >= since,
    ).length,
    openPullRequests: items.filter((item) => item.isPullRequest && item.state === "open").length,
  };
}

function configureGitPublisher() {
  run("gh", ["auth", "setup-git"]);
  run("git", ["config", "user.name", "deepseek-autofix[bot]"]);
  run("git", ["config", "user.email", "deepseek-autofix[bot]@users.noreply.github.com"]);
}

function publish() {
  const repository = requireForkRepository();
  const manifest = readJson(MANIFEST_PATH);
  const result = parseAgentResult(manifest.result);
  const safeTitle = sanitizePublishedTitle(result.title);
  const patchBytes = readFileSync(PATCH_PATH);
  const patchHash = createHash("sha256").update(patchBytes).digest("hex");
  if (patchHash !== manifest.patchSha256) {
    fail("bundle patch hash does not match manifest");
  }
  if (buildIssueFingerprint(result) !== manifest.fingerprint) {
    fail("bundle result fingerprint does not match manifest");
  }
  if (result.outcome === "fix-ready") {
    const reviewResult = parseReviewResult(manifest.review);
    if (reviewResult.verdict !== "pass") {
      fail("fix-ready bundle is missing a passing independent review");
    }
  }
  const currentSha = run("git", ["rev-parse", "HEAD"]);
  if (currentSha !== manifest.baseSha) {
    console.log(`Base moved from ${manifest.baseSha} to ${currentSha}; skipping stale bundle.`);
    return;
  }
  if (result.outcome === "no-action") {
    console.log("No publishable action was selected.");
    return;
  }

  if (result.outcome === "fix-ready") {
    run("git", ["apply", "--whitespace=error-all", PATCH_PATH]);
  }
  const validation = validate();
  run("git", ["diff", "--check"]);

  const counts = recentAutomationCounts(repository);
  const fingerprint = manifest.fingerprint;
  const automationItems = listAutomationItems(repository);
  const existingIssue = findOpenAutomationItem(automationItems, fingerprint, false);
  const existingPullRequest = findOpenAutomationItem(automationItems, fingerprint, true);
  if (existingPullRequest) {
    console.log(`Repair already has an open PR: ${existingPullRequest.url}`);
    return;
  }
  if (
    result.outcome === "fix-ready" &&
    (counts.openPullRequests >= DEFAULT_POLICY.maxOpenRepairPullRequests ||
      counts.newPullRequests >= DEFAULT_POLICY.maxNewPullRequestsPerDay)
  ) {
    console.log("Repair PR cap reached; preserving the bundle as an artifact only.");
    return;
  }
  if (!existingIssue && counts.newIssues >= DEFAULT_POLICY.maxNewIssuesPerDay) {
    console.log("Issue creation cap reached; preserving the bundle as an artifact only.");
    return;
  }

  configureGitPublisher();
  const issueNumber = upsertIssue({
    repository,
    title: safeTitle,
    body: result.issueBody,
    fingerprint,
  });
  if (result.outcome === "issue-only") {
    console.log(`Published or updated fork issue #${issueNumber}.`);
    return;
  }

  run("git", ["add", "--all", "--", ...validation.files]);
  run("git", ["diff", "--cached", "--check"]);
  const branch = `automation/deepseek/${branchSlug(result.title)}-${fingerprint.slice(0, 10)}`;
  run("git", ["switch", "-c", branch]);
  // The patch was already tested without credentials. Do not execute model-authored hooks here.
  run("git", ["commit", "--no-verify", "-m", `fix: ${safeTitle}`]);
  run("git", ["push", "origin", `HEAD:refs/heads/${branch}`]);
  const bodyPath = path.join(ARTIFACT_DIR, "pull-request-body.md");
  writeFileSync(
    bodyPath,
    `${AUTOFIX_MARKER}\n<!-- deepseek-autofix:fingerprint=${fingerprint} -->\n\nCloses #${issueNumber}\n\n${neutralizeMentions(result.prBody)}\n`,
    "utf8",
  );
  const url = run("gh", [
    "pr",
    "create",
    "--repo",
    repository,
    "--base",
    "main",
    "--head",
    branch,
    "--title",
    safeTitle,
    "--body-file",
    bodyPath,
  ]);
  console.log(`Created fork PR: ${url}`);
}

function syncUpstream() {
  const repository = requireForkRepository();
  const upstream = DEFAULT_POLICY.upstreamRepository;
  run("git", ["remote", "add", "upstream-autofix", `https://github.com/${upstream}.git`]);
  run("git", ["fetch", "--no-tags", "upstream-autofix", "main:refs/remotes/upstream-autofix/main"]);
  configureGitPublisher();
  run("git", ["fetch", "--no-tags", "origin", "main"]);
  const ahead = Number(
    run("git", [
      "rev-list",
      "--count",
      "refs/remotes/origin/main..refs/remotes/upstream-autofix/main",
    ]),
  );
  if (ahead === 0) {
    console.log("Fork main already contains upstream main.");
    return;
  }

  const branch = "automation/upstream-sync";
  const remoteBranch = run("git", ["ls-remote", "--heads", "origin", branch]);
  if (remoteBranch) {
    run("git", ["fetch", "--no-tags", "origin", `${branch}:refs/remotes/origin/${branch}`]);
    run("git", ["switch", "-C", branch, `refs/remotes/origin/${branch}`]);
  } else {
    run("git", ["switch", "-c", branch, "refs/remotes/origin/main"]);
  }

  const mergeOrReport = (ref) => {
    const merge = spawnSync("git", ["merge", "--no-edit", ref], {
      cwd: ROOT,
      encoding: "utf8",
    });
    if (merge.status === 0) {
      return true;
    }
    const conflicts = run("git", ["diff", "--name-only", "--diff-filter=U"]);
    run("git", ["merge", "--abort"]);
    const fingerprint = createHash("sha256")
      .update(`upstream-sync:${ref}:${conflicts}`)
      .digest("hex");
    upsertIssue({
      repository,
      title: "Upstream sync requires manual conflict resolution",
      fingerprint,
      marker: `${AUTOFIX_MARKER}\n${UPSTREAM_SYNC_MARKER}`,
      body: `The scheduled upstream sync could not merge \`${upstream}:main\` into this fork.\n\nConflicting paths:\n\n\`\`\`text\n${conflicts}\n\`\`\``,
    });
    console.log("Upstream sync conflicts were reported in the fork.");
    return false;
  };

  if (remoteBranch && !mergeOrReport("refs/remotes/origin/main")) {
    return;
  }
  if (!mergeOrReport("refs/remotes/upstream-autofix/main")) {
    return;
  }
  run("git", ["push", "origin", `HEAD:refs/heads/${branch}`]);
  const existing = ghJson([
    "pr",
    "list",
    "--repo",
    repository,
    "--state",
    "open",
    "--head",
    branch,
    "--json",
    "number,url",
  ]);
  if (existing.length > 0) {
    console.log(`Updated upstream sync PR: ${existing[0].url}`);
    return;
  }
  const bodyPath = path.join(ARTIFACT_DIR, "upstream-sync-body.md");
  ensureArtifactDir();
  writeFileSync(
    bodyPath,
    `${UPSTREAM_SYNC_MARKER}\n\nSynchronizes this fork with \`${upstream}:main\`. This PR is intentionally kept separate from DeepSeek-authored repairs.\n`,
    "utf8",
  );
  const url = run("gh", [
    "pr",
    "create",
    "--repo",
    repository,
    "--base",
    "main",
    "--head",
    branch,
    "--title",
    "chore: sync upstream main",
    "--body-file",
    bodyPath,
  ]);
  console.log(`Created upstream sync PR: ${url}`);
}

const [command, argument] = process.argv.slice(2);
const commands = {
  prepare,
  configure: () => configure(argument),
  agent: runAgent,
  validate,
  review,
  verify,
  package: packageBundle,
  publish,
  sync: syncUpstream,
};

if (!commands[command]) {
  console.error(`Usage: node scripts/deepseek-autofix.mjs <${Object.keys(commands).join("|")}>`);
  process.exit(2);
}

try {
  commands[command]();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
