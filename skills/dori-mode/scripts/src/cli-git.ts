import { type Command, die } from "./cli-context.ts";
import { approvePr, declinePr, landPr, openPr, showPr } from "./git-local.ts";

const pr: Command = async ({ positionals, opt, need, values, config, deps }) => {
  const sub = positionals[0] ?? die("用法：dori pr open|show|approve|decline <key>");
  const laneKey = positionals[1] ?? die("pr 需要 lane key");
  if (sub === "open") {
    const branch = opt("branch");
    const base = opt("base");
    const summary = opt("summary");
    const opened = await openPr(deps, laneKey, {
      ...(branch !== undefined ? { branch } : {}),
      ...(base !== undefined ? { base } : {}),
      ...(summary !== undefined ? { summary } : {}),
    });
    console.log(opened.line);
    console.log(opened.summaryLine);
    if (opened.testFailed) console.log(`PR_TESTS_FAILED ${laneKey}: 修复测试后重新 open`);
    process.exit(opened.testFailed ? 2 : 0);
  }
  if (sub === "show") {
    console.log(showPr(config.stateDir, laneKey));
    return;
  }
  if (sub === "approve") {
    console.log(await approvePr(deps, laneKey, need("by")));
    return;
  }
  if (sub === "decline") {
    const note = opt("note") ?? (values["reason"] as string[] | undefined)?.join(" ") ?? "";
    console.log(await declinePr(deps, laneKey, note));
    return;
  }
  die(`未知 pr 子命令：${sub}（open|show|approve|decline）`);
};

const land: Command = async ({ key, deps }) => {
  const result = await landPr(deps, key ?? die("land 需要 lane key"));
  console.log(result.line);
  process.exit(result.code);
};

export const gitCommands: Readonly<Record<string, Command>> = { pr, land };
