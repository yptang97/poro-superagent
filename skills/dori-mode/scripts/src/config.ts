import { homedir } from "node:os";
import { join } from "node:path";

import type { RuntimeKind } from "../../../../src/runtime/types.ts";
import type { SupervisionOptions } from "./supervision-observe.ts";
import type { CommitIdentity } from "./verify-pr-check.ts";

export type ArgvTemplate = readonly string[];

export type Hooks = {
  readonly threadReply?: ArgvTemplate;
  readonly threadDone?: ArgvTemplate;
  readonly transcribe?: ArgvTemplate;
};

/** Feishu is driven through the `lark-cli` binary and a saved app profile. */
export type FeishuConfig = {
  /** The lark-cli profile holding the app credential; omit to use lark-cli's active profile. */
  readonly profile?: string;
  /** The owner's open_id under this app; only this sender is a request. */
  readonly ownerId?: string;
  /** Optional chat gate: deliver only this chat's owner messages. */
  readonly chatId?: string;
};

/** The local-git flow: task branch, local PR summary, owner approval, merge into the base branch. */
export type GitConfig = {
  /** Absolute repo roots or worktree parents the Dori may land in; empty means no restriction. */
  readonly repos: readonly string[];
  readonly baseBranch: string;
  readonly branchPrefix: string;
  readonly pull: boolean;
  readonly mergeMode: "no-ff" | "ff-only" | "squash";
  readonly testCommand?: ArgvTemplate;
};

export type GuardThresholds = {
  readonly loadAlert: number;
  readonly loadOk: number;
  readonly memFreeMinPct: number;
  readonly diskFreeMinGb: number;
  readonly panesMax: number;
};

export type DoriConfig = {
  /** Where new sessions open; absent = detected (see run.ts runtimeChoice). */
  readonly runtime?: RuntimeKind;
  readonly stateDir: string;
  readonly laneWorkspace: string;
  readonly workspaces: readonly string[];
  readonly ignorePanes: readonly string[];
  readonly leadPane: string;
  readonly defaultCwd: string;
  readonly agentCommand: ArgvTemplate;
  readonly defaultModel: string;
  readonly launchKeywords: string;
  readonly goalMarker: string;
  /** How long `launch` waits for the agent's ready status and goal after it starts; a slow host is a host property. */
  readonly startupWaitSeconds: number;
  readonly sessionsDir: string;
  readonly nudgeAfterMin: number;
  readonly postAfterMin: number;
  readonly closeAfterMin: number;
  readonly heavySlots: number;
  readonly heavyMaxLoad: number;
  readonly deadPanePatterns: readonly string[];
  readonly guard: GuardThresholds;
  readonly hooks: Hooks;
  /** Expected Git author and committer per lowercase `owner/repo`, for `verify-pr` and the lane footer. */
  readonly repoIdentities: Readonly<Record<string, CommitIdentity>>;
  readonly supervision: SupervisionOptions;
  readonly feishu: FeishuConfig;
  readonly git: GitConfig;
};

export const defaultConfig = (home = homedir()): DoriConfig => ({
  stateDir: join(home, ".dori", "state"),
  laneWorkspace: "",
  workspaces: [],
  ignorePanes: [],
  leadPane: "",
  defaultCwd: home,
  agentCommand: ["omo", "--model", "{model}", "{prompt}"],
  defaultModel: "anthropic/claude-opus-5-5",
  launchKeywords: "ulw set goal and work",
  goalMarker: "Pursuing goal",
  startupWaitSeconds: 180,
  sessionsDir: join(home, ".omo", "agent", "sessions"),
  nudgeAfterMin: 15,
  postAfterMin: 20,
  closeAfterMin: 5,
  heavySlots: 1,
  heavyMaxLoad: 80,
  deadPanePatterns: ["has stopped", "no suitable jobs"],
  guard: { loadAlert: 150, loadOk: 80, memFreeMinPct: 20, diskFreeMinGb: 50, panesMax: 20 },
  hooks: {},
  repoIdentities: {},
  feishu: {},
  git: { repos: [], baseBranch: "main", branchPrefix: "", pull: true, mergeMode: "no-ff" },
  supervision: {
    hungAfterMinutes: 20,
    staleAfterMinutes: 20,
    defaults: { wallMinutes: null, tokens: null, costUsd: null },
  },
});

export const configPath = (): string => process.env["DORI_CONFIG"] ?? join(homedir(), ".dori", "config.json");

export const expandHome = (path: string, home = homedir()): string =>
  path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path;

const isIdentity = (value: unknown): value is CommitIdentity => {
  const v = value as { name?: unknown; email?: unknown } | null;
  return (
    typeof v === "object" &&
    v !== null &&
    typeof v.name === "string" &&
    !!v.name.trim() &&
    typeof v.email === "string" &&
    !!v.email.trim()
  );
};

// The file is untrusted JSON: keep only well-formed identities, so a bad entry reads as an unconfigured repo.
const repoIdentities = (value: unknown): Record<string, CommitIdentity> =>
  typeof value !== "object" || value === null || Array.isArray(value)
    ? {}
    : Object.fromEntries(
        Object.entries(value).flatMap(([repo, identity]) =>
          isIdentity(identity) ? [[repo.toLowerCase(), identity]] : [],
        ),
      );

const FEISHU_KEYS = new Set(["profile", "ownerId", "chatId"]);
const checkFeishu = (value: unknown): void => {
  if (value === undefined) return;
  if (!isRecord(value)) throw new ConfigError("invalid feishu: expected an object");
  for (const name of Object.keys(value)) {
    if (!FEISHU_KEYS.has(name)) throw new ConfigError(`invalid feishu ${name}: unknown setting`);
  }
  for (const name of FEISHU_KEYS) {
    const v = value[name];
    if (v !== undefined && (typeof v !== "string" || !v.trim()))
      throw new ConfigError(`invalid feishu ${name}: expected a non-empty string`);
  }
};

const MERGE_MODES = new Set(["no-ff", "ff-only", "squash"]);
const checkGit = (value: unknown): void => {
  if (value === undefined) return;
  if (!isRecord(value)) throw new ConfigError("invalid git: expected an object");
  for (const name of Object.keys(value)) {
    if (!["repos", "baseBranch", "branchPrefix", "pull", "mergeMode", "testCommand"].includes(name))
      throw new ConfigError(`invalid git ${name}: unknown setting`);
  }
  if (
    value["repos"] !== undefined &&
    !(Array.isArray(value["repos"]) && value["repos"].every((p) => typeof p === "string" && p.trim()))
  )
    throw new ConfigError("invalid git repos: expected an array of non-empty paths");
  if (value["baseBranch"] !== undefined && (typeof value["baseBranch"] !== "string" || !value["baseBranch"].trim()))
    throw new ConfigError("invalid git baseBranch: expected a non-empty string");
  if (value["branchPrefix"] !== undefined && typeof value["branchPrefix"] !== "string")
    throw new ConfigError("invalid git branchPrefix: expected a string");
  if (value["pull"] !== undefined && typeof value["pull"] !== "boolean")
    throw new ConfigError("invalid git pull: expected true or false");
  if (value["mergeMode"] !== undefined && !MERGE_MODES.has(String(value["mergeMode"])))
    throw new ConfigError('invalid git mergeMode: expected "no-ff", "ff-only" or "squash"');
  if (
    value["testCommand"] !== undefined &&
    value["testCommand"] !== null &&
    !(Array.isArray(value["testCommand"]) && value["testCommand"].every((p) => typeof p === "string" && p))
  )
    throw new ConfigError("invalid git testCommand: expected an array of strings or null");
};

export class ConfigError extends Error {}

const RUNTIMES: Readonly<Record<RuntimeKind, true>> = { herdr: true, hc: true };
const checkRuntime = (value: unknown): void => {
  if (value !== undefined && !(typeof value === "string" && Object.hasOwn(RUNTIMES, value)))
    throw new ConfigError(
      `invalid runtime: expected ${Object.keys(RUNTIMES)
        .map((k) => JSON.stringify(k))
        .join(" or ")}, got ${JSON.stringify(value)}`,
    );
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const SUPERVISION_KEYS = new Set([
  "hungAfterMinutes",
  "staleAfterMinutes",
  "defaults",
  "lanes",
  "usageArgv",
  "recordCostArgv",
  "activityPaths",
  "gitActivity",
]);
const CEILINGS = new Set(["wallMinutes", "tokens", "costUsd"]);
const checkCeilingNames = (where: string, budget: Record<string, unknown>): void => {
  for (const name of Object.keys(budget)) {
    if (!CEILINGS.has(name))
      throw new ConfigError(
        `invalid supervision ${where}.${name}: unknown ceiling (expected wallMinutes, tokens or costUsd)`,
      );
  }
};

// A malformed supervision entry stops with its name: dropping it could turn a ceiling off, and keeping it would crash
// every sweep later. A misspelt name is refused for the same reason.
const checkSupervision = (value: unknown): void => {
  if (value === undefined) return;
  if (!isRecord(value)) throw new ConfigError("invalid supervision: expected an object");
  for (const name of Object.keys(value)) {
    if (!SUPERVISION_KEYS.has(name)) throw new ConfigError(`invalid supervision ${name}: unknown setting`);
  }
  for (const name of ["defaults", "lanes"] as const) {
    if (value[name] !== undefined && !isRecord(value[name]))
      throw new ConfigError(`invalid supervision ${name}: expected an object`);
  }
  if (isRecord(value["defaults"])) checkCeilingNames("defaults", value["defaults"]);
  for (const [key, budget] of Object.entries(isRecord(value["lanes"]) ? value["lanes"] : {})) {
    if (!isRecord(budget)) throw new ConfigError(`invalid supervision lanes.${key}: expected an object`);
    checkCeilingNames(`lanes.${key}`, budget);
  }
  for (const name of ["usageArgv", "recordCostArgv", "activityPaths"] as const) {
    const list = value[name];
    if (list !== undefined && !(Array.isArray(list) && list.every((item) => typeof item === "string"))) {
      throw new ConfigError(`invalid supervision ${name}: expected an array of strings`);
    }
  }
  if (value["gitActivity"] !== undefined && typeof value["gitActivity"] !== "boolean")
    throw new ConfigError("invalid supervision gitActivity: expected true or false");
};

export const loadConfig = async (path = configPath(), home = homedir()): Promise<DoriConfig> => {
  const base = defaultConfig(home);
  const file = Bun.file(path);
  const raw = (await file.exists()) ? ((await file.json()) as Partial<DoriConfig>) : {};
  checkRuntime(raw.runtime);
  checkSupervision(raw.supervision);
  checkFeishu(raw.feishu);
  checkGit(raw.git);
  const rawGit = raw.git;
  const merged: DoriConfig = {
    ...base,
    ...raw,
    guard: { ...base.guard, ...raw.guard },
    hooks: { ...base.hooks, ...raw.hooks },
    feishu: { ...base.feishu, ...(raw.feishu ?? {}) },
    git: {
      ...base.git,
      ...(rawGit ?? {}),
      repos: (rawGit?.repos ?? base.git.repos).map((p) => expandHome(p, home)),
      ...(rawGit?.testCommand === null
        ? {}
        : rawGit?.testCommand !== undefined
          ? { testCommand: rawGit.testCommand }
          : {}),
    },
    repoIdentities: repoIdentities(raw.repoIdentities),
    // Only a string is a marker: null or false would quietly turn the goal check off, and an object would never show.
    goalMarker: typeof raw.goalMarker === "string" ? raw.goalMarker : base.goalMarker,
    // Only a nonnegative number is a wait: a string or null would otherwise end every launch at the first check.
    startupWaitSeconds:
      typeof raw.startupWaitSeconds === "number" &&
      Number.isFinite(raw.startupWaitSeconds) &&
      raw.startupWaitSeconds >= 0
        ? raw.startupWaitSeconds
        : base.startupWaitSeconds,
    supervision: {
      ...base.supervision,
      ...raw.supervision,
      defaults: { ...base.supervision.defaults, ...raw.supervision?.defaults },
    },
  };
  for (const [name, value] of Object.entries({
    hungAfterMinutes: merged.supervision.hungAfterMinutes,
    staleAfterMinutes: merged.supervision.staleAfterMinutes,
    ...merged.supervision.defaults,
  })) {
    if (value != null && (typeof value !== "number" || !Number.isFinite(value) || value < 0))
      throw new ConfigError(`invalid supervision ${name}: expected a nonnegative number or null`);
  }
  for (const [key, budget] of Object.entries(merged.supervision.lanes ?? {})) {
    for (const [name, value] of Object.entries(budget)) {
      if (value != null && (typeof value !== "number" || !Number.isFinite(value) || value < 0))
        throw new ConfigError(`invalid supervision lanes.${key}.${name}: expected a nonnegative number or null`);
    }
  }
  return {
    ...merged,
    stateDir: expandHome(process.env["DORI_STATE_DIR"] ?? merged.stateDir, home),
    defaultCwd: expandHome(merged.defaultCwd, home),
    feishu: {
      ...(process.env["DORI_FEISHU_PROFILE"] ?? merged.feishu.profile
        ? { profile: process.env["DORI_FEISHU_PROFILE"] ?? merged.feishu.profile }
        : {}),
      ...(process.env["DORI_FEISHU_OWNER_ID"] ?? merged.feishu.ownerId
        ? { ownerId: process.env["DORI_FEISHU_OWNER_ID"] ?? merged.feishu.ownerId }
        : {}),
      ...(process.env["DORI_FEISHU_CHAT_ID"] ?? merged.feishu.chatId
        ? { chatId: process.env["DORI_FEISHU_CHAT_ID"] ?? merged.feishu.chatId }
        : {}),
    },
    git: {
      ...merged.git,
      repos: merged.git.repos.map((p) => expandHome(p, home)),
    },
    sessionsDir: expandHome(merged.sessionsDir, home),
    leadPane:
      process.env["DORI_LEAD_PANE"] ||
      process.env["HERDR_PANE_ID"] ||
      process.env["HC_TERMINAL_ID"] ||
      merged.leadPane,
  };
};

export const fill = (template: ArgvTemplate, values: Readonly<Record<string, string>>): string[] =>
  template.map((part) => part.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole));
