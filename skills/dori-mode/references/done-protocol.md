# Lane done protocol

Give this file to every lane you launch.

When your lane's `Done =` signals are live and the task branch is committed, claim done from your own session. In this fork the usual signal is `local-merged <branch> base=<main>`: the lead has merged your approved local PR into the base branch. GitHub PRs, closed issues and published versions remain available for repos that use them, and command/file/url signals cover local or QA-only work.

```sh
dori claim-done <your-lane-key> --evidence "<local PR summary path, head SHA, merge SHA>"
```

The key is in your brief's lane footer. If you leave it out, the lane registered for your pane is used.

## What happens next

1. The Dori gets a `LANE_DONE_CLAIMED` event, and you get a `[LEAD]` line saying when the lane closes.
2. Stay idle and start no new work.
3. If the Dori does not object within 5 minutes, the watcher closes the lane. Before closing, it reads back every `Done =` signal live. It refuses to close if any of your worktrees still has uncommitted tracked changes, or, when a remote exists, commits that are on no remote. A local repo with no remote is not blocked for having local commits.
4. Closing marks your thread done (when a thread hook is configured), closes your tab, and removes your worktrees.

## If the Dori objects, or a check fails

You get `[LEAD] not done: <reasons>; keep working, claim again when fixed` in your pane, and the lane goes back to not-done. This happens when:

- the Dori objects;
- a `Done =` signal does not read back live;
- there is uncommitted tracked work, or, on a repo with a remote, commits that reached no remote (the reason names the path).

Fix every reason, then claim again. A new claim starts a fresh 5-minute window.
