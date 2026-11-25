import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";import { join } from "node:path";

import { defaultConfig } from "../src/config.ts";
import type { FlowDeps } from "../src/done-flow.ts";
import { approvePr, landPr, openPr, readPr } from "../src/git-local.ts";
import { unpushedWork } from "../src/done-flow.ts";
import { Registry } from "../src/registry.ts";
import { run } from "../src/run.ts";
import { checkSignal } from "../src/signals.ts";
import { withState } from "./fakes.ts";

const git = async (dir: string, ...args: string[]) => {
  const r = await run(["git", "-C", dir, ...args], { timeoutMs: 120_000 });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.err || r.out}`);
  return r.out.trim();
};

const repo = async () => {
  const state = withState();
  const dir = join(state.dir, "repo");
  mkdirSync(dir);
  await git(dir, "init", "-b", "main");
  await git(dir, "config", "user.email", "test@example.com");
  await git(dir, "config", "user.name", "Test");
  writeFileSync(join(dir, "base.txt"), "base\n");
  await git(dir, "add", "-A");
  await git(dir, "commit", "-m", "base");
  await git(dir, "checkout", "-b", "demo");
  writeFileSync(join(dir, "work.txt"), "work\n");
  await git(dir, "add", "-A");
  await git(dir, "commit", "-m", "feature work");
  const config = {
    ...defaultConfig(dir),
    stateDir: join(state.dir, "state"),
    defaultCwd: dir,
    git: { repos: [dir], baseBranch: "main", branchPrefix: "", pull: false, mergeMode: "no-ff" as const },
  };
  const registry = new Registry(config.stateDir);
  await registry.write({
    key: "demo",
    title: "demo",
    thread: "none",
    brief: join(dir, "brief.md"),
    done: "local-merged demo base=main",
    cwd: dir,
    openedAt: new Date().toISOString(),
  });
  const clock = { now: () => Date.now(), sleep: async () => {} };
  const deps: FlowDeps = { run, clock, registry, config, exists: existsSync };
  return { state, dir, config, deps };
};

const hasGit = Boolean(Bun.which("git"));

test.skipIf(!hasGit)("local PR opens, waits for approval, then lands on the base branch", async () => {
  const r = await repo();
  try {
    const opened = await openPr(r.deps, "demo");
    expect(opened.line).toContain("PR_OPEN demo demo -> main");
    expect(opened.line).toContain("test=skipped");
    expect(opened.pr.head).toHaveLength(40);

    const waiting = await landPr(r.deps, "demo");
    expect(waiting.code).toBe(3);
    expect(waiting.line).toContain("PR_WAITING demo");

    expect(await approvePr(r.deps, "demo", "owner")).toContain("PR_APPROVED demo");
    const landed = await landPr(r.deps, "demo");
    expect(landed.code).toBe(0);
    expect(landed.line).toContain("MERGED demo demo -> main");

    expect(await git(r.dir, "log", "--oneline", "main")).toContain("feature work");
    expect(await git(r.dir, "status", "--porcelain")).toBe("");
    const pr = readPr(r.config.stateDir, "demo");
    expect(pr?.state).toBe("merged");
    expect(pr?.merged?.mergeSha).toHaveLength(40);

    const signal = await checkSignal("local-merged demo base=main", run, { cwd: r.dir });
    expect(signal.ok).toBe(true);
  } finally {
    r.state.done();
  }
});

test.skipIf(!hasGit)("an approval is tied to the head: a later commit refuses the merge", async () => {
  const r = await repo();
  try {
    await openPr(r.deps, "demo");
    await approvePr(r.deps, "demo", "owner");
    await git(r.dir, "checkout", "demo");
    writeFileSync(join(r.dir, "work.txt"), "work changed\n");
    await git(r.dir, "add", "-A");
    await git(r.dir, "commit", "-m", "late change");
    await git(r.dir, "checkout", "main");
    await expect(landPr(r.deps, "demo")).rejects.toThrow("分支在批准后变化");
    await git(r.dir, "checkout", "demo");
    expect(await git(r.dir, "status", "--porcelain")).toBe("");
  } finally {
    r.state.done();
  }
});

test.skipIf(!hasGit)("uncommitted tracked work refuses a local PR", async () => {
  const r = await repo();
  try {
    writeFileSync(join(r.dir, "work.txt"), "dirty\n");
    await expect(openPr(r.deps, "demo")).rejects.toThrow("未提交");
    await git(r.dir, "checkout", "--", "work.txt");
  } finally {
    r.state.done();
  }
});

test.skipIf(!hasGit)("a repo outside git.repos is refused", async () => {
  const r = await repo();
  try {
    const blocked: FlowDeps = {
      ...r.deps,
      config: {
        ...r.config,
        git: { ...r.config.git, repos: [join(r.dir, "somewhere-else")] },
      },
    };
    await expect(openPr(blocked, "demo")).rejects.toThrow("白名单");
  } finally {
    r.state.done();
  }
});

test.skipIf(!hasGit)("a local repo with no remote has no unpushed work to block a close", async () => {
  const r = await repo();
  try {
    const lane = (await r.deps.registry.read("demo"))!;
    expect(await unpushedWork(r.deps, lane)).toEqual([]);
    writeFileSync(join(r.dir, "work.txt"), "dirty\n");
    expect(await unpushedWork(r.deps, lane)).toEqual([`uncommitted work in ${r.dir}`]);
    await git(r.dir, "checkout", "--", "work.txt");
  } finally {
    r.state.done();
  }
});

test.skipIf(!hasGit)("a local-merged lane is not blocked by commits its remote lacks", async () => {
  const r = await repo();
  try {
    const remote = join(r.state.dir, "remote.git");
    await git(r.state.dir, "init", "--bare", remote);
    await git(r.dir, "remote", "add", "origin", remote);
    await git(r.dir, "push", "-u", "origin", "main");
    const lane = (await r.deps.registry.read("demo"))!;
    expect(await unpushedWork(r.deps, { ...lane, done: "merged acme/app#1" })).toEqual([
      `unpushed work in ${r.dir}`,
    ]);
    expect(await unpushedWork(r.deps, lane)).toEqual([]);
  } finally {
    r.state.done();
  }
});

test.skipIf(!hasGit)("a configured test suite refuses a branch that is not checked out", async () => {
  const r = await repo();
  try {
    await git(r.dir, "checkout", "main");
    const withTests: FlowDeps = {
      ...r.deps,
      config: { ...r.config, git: { ...r.config.git, testCommand: ["git", "--version"] } },
    };
    await expect(openPr(withTests, "demo")).rejects.toThrow("未在任何 worktree 中检出");
  } finally {
    r.state.done();
  }
});
