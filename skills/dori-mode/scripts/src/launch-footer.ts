import { fileURLToPath } from "node:url";

import type { DoriConfig } from "./config.ts";
import type { Lane } from "./registry.ts";

// The footer names this CLI by path: a bare `dori` can resolve to the root harness, whose `report` accepts unknown
// flags and writes no journal, so a jsonl-v1 lane would read NO-REPORT for its whole life.
export const shellQuote = (s: string): string => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);
export const cliCommand = (path: string = fileURLToPath(new URL("./cli.ts", import.meta.url))): string =>
  `bun ${shellQuote(path)}`;
const CLI = cliCommand();

const FOOTER_HEADING = "## Lane footer (written by dori launch)";
export const BRIEF_START = "<!-- dori launch: the brief starts below -->";
const FOOTER_START = "<!-- dori launch: footer start -->";
const FOOTER_END = "<!-- dori launch: footer end -->";

// startLane writes the launch text over the brief before the tab exists, so a retry after a failed tab create reads a
// brief that already has lessons and a footer. Rebuild from the text between the markers launch wrote, so a retry ships
// what a first launch would. Only a file that ends with launch's footer is cut: the owner's text may quote the heading.
export const originalBrief = (text: string): string => {
  const brief = text.replace(/\s*$/, "");
  const foot = brief.endsWith(FOOTER_END) ? brief.lastIndexOf(`\n${FOOTER_START}\n`) : -1;
  if (foot === -1) return brief;
  const start = brief.indexOf(`${BRIEF_START}\n`);
  return brief.slice(start === -1 || start > foot ? 0 : start + BRIEF_START.length + 1, foot).replace(/\s*$/, "");
};

export const footer = (
  lane: Lane,
  leadPane: string,
  identities: DoriConfig["repoIdentities"] = {},
  git?: DoriConfig["git"],
): string => {
  const base = git?.baseBranch ?? "main";
  const branch = `${git?.branchPrefix ?? ""}${lane.key}`;
  return [
    "",
    FOOTER_START,
    FOOTER_HEADING,
    `- Key: ${lane.key}. Work thread: ${lane.thread}.`,
    `- Done = ${lane.done}. The lane closes only when every signal reads back live.`,
    `- Persist each milestone, blocker, question, halt and completion with ${CLI} report ${lane.key} --kind milestone|blocker|question|halted|done --text "what, with evidence links". It appends reports.jsonl and prints the human [REPORT] line; send that line to pane ${leadPane || "(lead pane)"} as an argv array, never a shell string.`,
    `- Work on the task branch \`${branch}\` in this repository. Commit there; never commit directly to \`${base}\`.`,
    `- When the work is ready: run ${CLI} pr open ${lane.key} --branch ${branch} --base ${base} --summary "one line". It runs the configured tests and writes a local PR summary, printing PR_OPEN and PR_SUMMARY. Send both lines to pane ${leadPane || "(lead pane)"} and wait; never merge yourself. The lead merges only after the owner approves.`,
    `- The local Done signal is \`local-merged ${branch} base=${base}\`. The lane closes only when every signal reads back live.`,
    ...(Object.keys(identities).length
      ? [
          "- Before committing, set the repository's identity below for that command only; never change the global Git identity. For a repository not listed, ask the lead for its identity before the first commit.",
          ...Object.entries(identities).map(
            ([repo, identity]) =>
              `  - ${repo}: git -c user.name=${quoteForPane(identity.name)} -c user.email=${quoteForPane(identity.email)} commit ...`,
          ),
        ]
      : []),
    `- After each completed step: ${CLI} checkpoint ${lane.key} --step <unique-step> --result <result> --evidence <path-or-URL> [--remote-effect <completed-push/merge/deploy-receipt>] (one flag per receipt).`,
    `- On resume, run ${CLI} checkpoints ${lane.key} before doing work. Never repeat a recorded remote side effect. If a crash may have happened between the remote action and checkpoint, read the live remote receipt first and use the service's idempotency key; a local journal cannot make that remote action atomic.`,
    `- Supervision ceilings: ${JSON.stringify(lane.budget ?? {})}. A breach marks blocked and alerts; it never kills the agent. Report a blocker and wait for the lead's decision rather than overriding the ceiling.`,
    `- When done: ${CLI} claim-done ${lane.key} --evidence "<PR summary path, head SHA, merge receipt>". See references/done-protocol.md.`,
    FOOTER_END,
    "",
  ].join("\n");
};

export const quoteForPane = (arg: string): string =>
  /^[\w./:@=-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
