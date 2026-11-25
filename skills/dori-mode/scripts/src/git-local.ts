import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { DoriConfig, GitConfig } from "./config.ts";
import type { FlowDeps } from "./done-flow.ts";
import { LANE_KEY, type Lane, statusOf } from "./registry.ts";
import { iso } from "./run.ts";

export class GitLocalError extends Error {}

export type LocalPrState = "open" | "approved" | "merged" | "declined";

export type LocalPr = {
  readonly key: string;
  readonly repo: string;
  readonly branch: string;
  readonly base: string;
  readonly head: string;
  readonly openedAt: string;
  readonly state: LocalPrState;
  readonly commits: readonly string[];
  readonly files: readonly string[];
  readonly diffstat: string;
  readonly test: "pass" | "fail" | "skipped";
  readonly summary?: string;
  readonly approval?: { readonly by: string; readonly at: string; readonly head: string };
  readonly merged?: { readonly at: string; readonly mergeSha: string };
};

export type OpenPrInput = {
  readonly branch?: string;
  readonly base?: string;
  readonly summary?: string;
};

export type OpenPrResult = {
  readonly pr: LocalPr;
  readonly line: string;
  readonly summaryLine: string;
  readonly testFailed: boolean;
};

const short = (s: string) => s.slice(0, 12);

const normalize = (p: string): string => resolve(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

const allowedRepo = (config: GitConfig, root: string): boolean => {
  if (config.repos.length === 0) return true;
  const r = normalize(root);
  return config.repos.some((repo) => {
    const w = normalize(repo);
    return r === w || r.startsWith(`${w}/`);
  });
};

const git = async (deps: FlowDeps, cwd: string, args: readonly string[], timeoutMs = 120_000) =>
  deps.run(["git", "-C", cwd, ...args], { timeoutMs });

const must = async (deps: FlowDeps, cwd: string, args: readonly string[], timeoutMs = 120_000): Promise<string> => {
  const r = await git(deps, cwd, args, timeoutMs);
  if (r.code !== 0) throw new GitLocalError(`git ${args.join(" ")}: ${(r.err || r.out).trim().slice(0, 300)}`);
  return r.out.trim();
};

export const prPath = (stateDir: string, key: string): string =>
  LANE_KEY.test(key) ? join(stateDir, "prs", `${key}.json`) : "";

export const readPr = (stateDir: string, key: string): LocalPr | null => {
  const path = prPath(stateDir, key);
  if (!path || !existsSync(path)) return null;
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof raw === "object" && raw !== null ? (raw as LocalPr) : null;
  } catch {
    return null;
  }
};

const writePr = (stateDir: string, pr: LocalPr): void => {
  const path = prPath(stateDir, pr.key);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(pr, null, 1));
};

const prMarkdown = (pr: LocalPr): string =>
  [
    `# 本地 PR：${pr.key}`,
    "",
    `- 仓库：${pr.repo}`,
    `- 分支：${pr.branch} -> ${pr.base}`,
    `- Head：${pr.head}`,
    `- 状态：${pr.state}`,
    `- 测试：${pr.test}`,
    ...(pr.summary ? [`- 摘要：${pr.summary}`] : []),
    "",
    "## 提交",
    ...pr.commits.map((c) => `- ${c}`),
    "",
    "## 变更",
    "```",
    pr.diffstat || "(无文件变更)",
    "```",
    "",
  ].join("\n");

export const showPr = (stateDir: string, key: string): string => {
  const pr = readPr(stateDir, key);
  if (!pr) return `PR_NONE ${key}`;
  const approval = pr.approval ? ` approvedBy=${pr.approval.by}` : "";
  const merged = pr.merged ? ` merge=${short(pr.merged.mergeSha)}` : "";
  return `PR ${key} ${pr.state} ${pr.branch} -> ${pr.base} head=${short(pr.head)} test=${pr.test}${approval}${merged}`;
};

const findWorktree = async (deps: FlowDeps, root: string, branch: string): Promise<string | undefined> => {
  const out = await must(deps, root, ["worktree", "list", "--porcelain"]);
  let path = "";
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice(9).trim();
    else if (line.trim() === `branch refs/heads/${branch}`) return path;
  }
  return undefined;
};

const cleanTracked = async (deps: FlowDeps, cwd: string): Promise<void> => {
  const dirty = await must(deps, cwd, ["status", "--porcelain", "--untracked-files=no"]);
  if (dirty) throw new GitLocalError(`工作区有未提交的已跟踪改动：${cwd}`);
};

const branchOf = async (deps: FlowDeps, root: string, branch: string): Promise<string> => {
  const r = await git(deps, root, ["rev-parse", "--verify", `refs/heads/${branch}`]);
  if (r.code !== 0) throw new GitLocalError(`分支不存在：${branch}`);
  return r.out.trim();
};

const resolveRepo = async (deps: FlowDeps, lane: Lane): Promise<string> => {
  const cwd = lane.cwd ?? deps.config.defaultCwd;
  const r = await git(deps, cwd, ["rev-parse", "--show-toplevel"], 30_000);
  if (r.code !== 0) throw new GitLocalError(`${cwd} 不是 git 仓库：${(r.err || r.out).trim().slice(0, 200)}`);
  const root = r.out.trim().replace(/\\/g, "/");
  if (!allowedRepo(deps.config.git, root))
    throw new GitLocalError(`仓库不在白名单：${root}（配置 git.repos）`);
  return root;
};

const branchName = (config: DoriConfig, key: string, input: OpenPrInput): string => {
  const branch = input.branch?.trim() || `${config.git.branchPrefix}${key}`;
  if (!branch || branch.startsWith("-")) throw new GitLocalError(`无效分支名：${branch}`);
  return branch;
};

/**
 * Test the task branch, then write a local PR record. The branch is not merged here: the owner approves the printed
 * summary first, and `land` performs the merge.
 */
export const openPr = async (deps: FlowDeps, key: string, input: OpenPrInput = {}): Promise<OpenPrResult> => {
  const lane = await deps.registry.read(key);
  if (!lane) throw new GitLocalError(`没有注册的 lane：${key}`);
  if (statusOf(lane) === "closed") throw new GitLocalError(`lane 已关闭：${key}`);
  const repo = await resolveRepo(deps, lane);
  const branch = branchName(deps.config, key, input);
  const base = input.base?.trim() || deps.config.git.baseBranch;
  if (branch === base) throw new GitLocalError(`任务分支不能等于主分支：${base}`);
  const head = await branchOf(deps, repo, branch);
  await branchOf(deps, repo, base);
  const count = Number(await must(deps, repo, ["rev-list", "--count", `${base}..${branch}`]));
  if (!Number.isFinite(count) || count < 1) throw new GitLocalError(`${branch} 相对 ${base} 没有新提交`);
  const worktree = await findWorktree(deps, repo, branch);
  const testCommand = deps.config.git.testCommand;
  if (testCommand?.length && !worktree)
    throw new GitLocalError(`分支 ${branch} 未在任何 worktree 中检出；测试必须在分支代码上运行，请先检出后再 open`);
  if (worktree) await cleanTracked(deps, worktree);
  const commits = (await must(deps, repo, ["log", "--format=%h %s", `${base}..${branch}`]))
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const files = (await must(deps, repo, ["diff", "--name-only", `${base}...${branch}`]))
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const diffstat = await must(deps, repo, ["diff", "--stat", `${base}...${branch}`]);
  let test: LocalPr["test"] = "skipped";
  let testFailed = false;
  if (testCommand?.length) {
    const runIn = worktree ?? repo;
    const r = await deps.run(testCommand, { cwd: runIn, timeoutMs: 600_000 });
    test = r.code === 0 ? "pass" : "fail";
    testFailed = r.code !== 0;
  }
  const pr: LocalPr = {
    key,
    repo,
    branch,
    base,
    head,
    openedAt: iso(deps.clock),
    state: "open",
    commits,
    files,
    diffstat,
    test,
    ...(input.summary?.trim() ? { summary: input.summary.trim() } : {}),
  };
  writePr(deps.config.stateDir, pr);
  writeFileSync(`${prPath(deps.config.stateDir, key)}.md`, prMarkdown(pr));
  return {
    pr,
    testFailed,
    line: `PR_OPEN ${key} ${branch} -> ${base} head=${short(head)} commits=${count} files=${files.length} test=${test}`,
    summaryLine: `PR_SUMMARY ${key} ${branch} -> ${base}; ${commits.length} commit(s); test=${test}; ${diffstat.split("\n").at(-1) ?? diffstat}`,
  };
};

export const approvePr = async (deps: FlowDeps, key: string, by: string): Promise<string> => {
  const pr = readPr(deps.config.stateDir, key);
  if (!pr) throw new GitLocalError(`没有本地 PR：${key}（先运行 dori pr open ${key}）`);
  if (pr.state === "merged") throw new GitLocalError(`PR 已合并：${key}`);
  if (pr.state === "declined") throw new GitLocalError(`PR 已拒绝：${key}（重新打开一个新的 PR）`);
  const head = await branchOf(deps, pr.repo, pr.branch);
  if (head !== pr.head) throw new GitLocalError(`分支已变化：${pr.branch} head=${short(head)}，PR 记录的 head=${short(pr.head)}；请重新 open`);
  const approved: LocalPr = {
    ...pr,
    state: "approved",
    approval: { by: by.trim() || "owner", at: iso(deps.clock), head: pr.head },
  };
  writePr(deps.config.stateDir, approved);
  writeFileSync(`${prPath(deps.config.stateDir, key)}.md`, prMarkdown(approved));
  return `PR_APPROVED ${key} ${pr.branch} by=${approved.approval?.by} head=${short(pr.head)}`;
};

export const declinePr = async (deps: FlowDeps, key: string, reason: string): Promise<string> => {
  const pr = readPr(deps.config.stateDir, key);
  if (!pr) throw new GitLocalError(`没有本地 PR：${key}`);
  if (pr.state === "merged") throw new GitLocalError(`PR 已合并，不能拒绝：${key}`);
  const summary = reason.trim() || pr.summary;
  const next: LocalPr = { ...pr, state: "declined", ...(summary ? { summary } : {}) };
  writePr(deps.config.stateDir, next);
  writeFileSync(`${prPath(deps.config.stateDir, key)}.md`, prMarkdown(next));
  return `PR_DECLINED ${key} ${reason.trim()}`;
};

const pullBase = async (deps: FlowDeps, baseWt: string): Promise<void> => {
  if (!deps.config.git.pull) return;
  const remotes = await git(deps, baseWt, ["remote"], 30_000);
  if (remotes.code !== 0 || !remotes.out.trim()) return;
  const fetched = await git(deps, baseWt, ["fetch", "--all", "--prune"], 120_000);
  if (fetched.code !== 0) throw new GitLocalError(`git fetch 失败：${(fetched.err || fetched.out).trim().slice(0, 200)}`);
  const upstream = await git(deps, baseWt, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], 30_000);
  if (upstream.code !== 0) return;
  const pulled = await git(deps, baseWt, ["pull", "--ff-only"], 120_000);
  if (pulled.code !== 0) throw new GitLocalError(`git pull --ff-only 失败：${(pulled.err || pulled.out).trim().slice(0, 200)}`);
};

const mergeInto = async (deps: FlowDeps, baseWt: string, pr: LocalPr): Promise<string> => {
  const mode = deps.config.git.mergeMode;
  const args =
    mode === "ff-only"
      ? ["merge", "--ff-only", pr.branch]
      : mode === "squash"
        ? ["merge", "--squash", pr.branch]
        : ["merge", "--no-ff", pr.branch, "-m", `Merge ${pr.branch} into ${pr.base}`];
  const merged = await git(deps, baseWt, args, 300_000);
  if (merged.code !== 0) {
    await git(deps, baseWt, ["merge", "--abort"], 30_000);
    throw new GitLocalError(`MERGE_CONFLICT ${pr.branch} -> ${pr.base}: ${(merged.err || merged.out).trim().slice(0, 300)}`);
  }
  if (mode === "squash") {
    const committed = await git(deps, baseWt, ["commit", "-m", `Merge ${pr.branch} into ${pr.base}`], 120_000);
    if (committed.code !== 0)
      throw new GitLocalError(`squash 提交失败：${(committed.err || committed.out).trim().slice(0, 200)}`);
  }
  return must(deps, baseWt, ["rev-parse", "HEAD"]);
};

/** Merge only an approved PR whose recorded head is still the branch head. Pulls the base branch first. */
export const landPr = async (deps: FlowDeps, key: string): Promise<{ line: string; code: number }> => {
  let pr = readPr(deps.config.stateDir, key);
  if (!pr) {
    const opened = await openPr(deps, key);
    return { line: `${opened.line}\n${opened.summaryLine}`, code: opened.testFailed ? 2 : 0 };
  }
  if (pr.state === "merged") return { line: `MERGED ${key} ${pr.branch} -> ${pr.base} merge=${short(pr.merged?.mergeSha ?? "")}`, code: 0 };
  if (pr.state !== "approved")
    return { line: `PR_WAITING ${key} ${pr.branch} -> ${pr.base} head=${short(pr.head)}（确认后运行 dori pr approve ${key} --by <owner>）`, code: 3 };
  if (pr.test === "fail") throw new GitLocalError(`测试未通过，拒绝合并：${key}`);
  const head = await branchOf(deps, pr.repo, pr.branch);
  if (head !== pr.head)
    throw new GitLocalError(`分支在批准后变化：${pr.branch} head=${short(head)}，批准时 ${short(pr.head)}；请重新 open/approve`);
  if (!allowedRepo(deps.config.git, pr.repo)) throw new GitLocalError(`仓库不在白名单：${pr.repo}`);
  let baseWt = await findWorktree(deps, pr.repo, pr.base);
  if (!baseWt) {
    const current = (await must(deps, pr.repo, ["branch", "--show-current"], 30_000)).trim();
    if (current !== pr.base) {
      await cleanTracked(deps, pr.repo);
      await must(deps, pr.repo, ["checkout", pr.base], 120_000);
    }
    baseWt = pr.repo;
  }
  await cleanTracked(deps, baseWt);
  await pullBase(deps, baseWt);
  const mergeSha = await mergeInto(deps, baseWt, pr);
  await git(deps, pr.repo, ["tag", "-f", `dori-merged/${key}`, mergeSha], 30_000);
  pr = { ...pr, state: "merged", merged: { at: iso(deps.clock), mergeSha } };
  writePr(deps.config.stateDir, pr);
  writeFileSync(`${prPath(deps.config.stateDir, key)}.md`, prMarkdown(pr));
  return { line: `MERGED ${key} ${pr.branch} -> ${pr.base} merge=${short(mergeSha)}`, code: 0 };
};
