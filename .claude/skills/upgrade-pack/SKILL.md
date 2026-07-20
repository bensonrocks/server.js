---
name: upgrade-pack
description: Build a portable upgrade pack (git patches + apply script + instructions) from recent commits on this branch, so another branch or copy of the codebase can adopt the same improvements. Use when the user asks to "sync", "port", "upgrade another branch", or says /upgrade-pack.
---

# Upgrade Pack Builder

Package a range of commits from this branch into a self-contained folder the
user can hand to another branch, another repository copy, or another Claude
Code session.

## Arguments

`/upgrade-pack [range]` — optional commit range or day spec.
- No argument → all of TODAY's commits (`git log --since="<today> 00:00"`).
- `3d`, `1w` → commits from the last N days/weeks.
- `abc123..def456` → explicit range, used as-is.
- `abc123` (single ref) → `abc123..HEAD`.

## Steps

1. **Resolve the range.** Find the first commit in the window and its parent
   (`BASE`); the range is `BASE..HEAD` (or the explicit range given). Show the
   user the commit list (`git log --oneline`) that will be packaged.
2. **Build the pack** in the scratchpad directory:
   - `upgrade-pack/patches/` — `git format-patch BASE..LAST -o patches/`
   - `upgrade-pack/apply-upgrade.sh` — apply script (template below).
   - `upgrade-pack/UPGRADE-INSTRUCTIONS.md` — three options ordered by ease:
     (A) same-repo cherry-pick with the exact fetch + cherry-pick commands;
     (B) the apply script for a diverged copy;
     (C) a paste-ready prompt for a Claude Code session on the target branch,
     PLUS a table of every patch (number, commit, one-line functional
     description — write these from the commit messages, not just subjects)
     and the cross-cutting rules from CLAUDE.md that the target must keep
     (Express route ordering before `/api/transport/:id`, the `logAudit`
     bare-`type` trap, `node --check` after every edit), and a short verify
     checklist relevant to the packaged features.
3. **Verify before shipping** (mandatory):
   - `bash -n apply-upgrade.sh`
   - Apply the whole series onto a throwaway worktree of `BASE`
     (`git worktree add -f /tmp/upgrade-verify BASE`, then `git am -3` all
     patches) and confirm `git diff --stat HEAD LAST` is EMPTY — the patched
     result must be byte-identical to the real branch tip. Remove the
     worktree afterwards.
4. **Zip** the folder (`idealone-upgrade-<YYYY-MM-DD>.zip`) and send BOTH the
   zip and the UPGRADE-INSTRUCTIONS.md (separately, so it's readable without
   unzipping) to the user with SendUserFile.

## apply-upgrade.sh requirements

The script must:
- refuse to run unless CWD is the repo root (`server.js` + `public/` exist)
  and the working tree is clean;
- accept optional patch numbers as arguments (`./apply-upgrade.sh 0014 0015`)
  and default to all patches;
- skip patches whose Subject line already appears in `git log` (re-run safe);
- apply with `git am -3`; on failure `git am --abort` and record the patch as
  needing manual/AI merge (never leave the repo mid-am);
- syntax-check `server.js`, `public/app.js`, `lib/keyfields.js` with
  `node --check` at the end;
- finish with either a "all applied, review + push" message or the list of
  failed patches and a pointer to Option C in UPGRADE-INSTRUCTIONS.md.

A proven reference implementation of this script and instruction file was
built on 2026-07-17 (commit range `bfda923..995f643`) — mirror that shape.
