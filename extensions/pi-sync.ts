import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

const REPO_URL = "https://github.com/shishirbh/pi-settings.git";
const PI_HOME = process.env.HOME || process.env.USERPROFILE || "~";
const CACHE_DIR = path.join(PI_HOME, ".pi", "sync-cache");
const AGENT_DIR = path.join(PI_HOME, ".pi", "agent");

const SYNC_DIRS = ["extensions", "skills"];
const SYNC_FILES = ["settings.json", "LEARNINGS.md", "APPEND_SYSTEM.md"];

function git(args: string[], cwd: string): string | null {
  try {
    return execSync(`git ${args.join(" ")}`, {
      cwd,
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 30_000,
    }).trim();
  } catch {
    return null;
  }
}

function isRepo(): boolean {
  return fs.existsSync(path.join(CACHE_DIR, ".git"));
}

function cloneOrPull(): string | null {
  if (!isRepo()) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const result = git(["clone", REPO_URL, "."], CACHE_DIR);
    if (result === null) return "Failed to clone repo";
    return null;
  }

  // Stash any local changes, pull, then pop stash
  git(["stash", "--include-untracked"], CACHE_DIR);
  const pull = git(["pull", "--rebase", "origin", "main"], CACHE_DIR);
  if (pull === null) {
    // Hard reset to remote as fallback
    git(["fetch", "origin"], CACHE_DIR);
    const reset = git(["reset", "--hard", "origin/main"], CACHE_DIR);
    if (reset === null) return "Failed to pull from repo";
  }
  git(["stash", "pop"], CACHE_DIR); // best effort
  return null;
}

/** Recursively copy a directory (overwrites existing). */
function copyDir(src: string, dest: string) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/** Copy .pi/agent/* into the repo cache. */
function localToRepo() {
  for (const dir of SYNC_DIRS) {
    const src = path.join(AGENT_DIR, dir);
    const dest = path.join(CACHE_DIR, dir);
    if (fs.existsSync(src)) {
      // Remove dest first for clean sync (handles deletions)
      if (fs.existsSync(dest)) {
        fs.rmSync(dest, { recursive: true, force: true });
      }
      copyDir(src, dest);
    }
  }
  for (const file of SYNC_FILES) {
    const src = path.join(AGENT_DIR, file);
    const dest = path.join(CACHE_DIR, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
    }
  }
}

/** Copy repo cache into .pi/agent/. */
function repoToLocal() {
  for (const dir of SYNC_DIRS) {
    const src = path.join(CACHE_DIR, dir);
    const dest = path.join(AGENT_DIR, dir);
    if (fs.existsSync(src)) {
      copyDir(src, dest);
    }
  }
  for (const file of SYNC_FILES) {
    const src = path.join(CACHE_DIR, file);
    const dest = path.join(AGENT_DIR, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
    }
  }
}

function pushToRemote(): string | null {
  // Pull first to avoid non-fast-forward conflicts
  const pull = git(["pull", "--rebase", "origin", "main"], CACHE_DIR);
  if (pull === null) {
    // Rebase may have conflicts — abort and tell user to resolve manually
    git(["rebase", "--abort"], CACHE_DIR);
    return "Conflict detected — run /sync-pull first, then /sync-push";
  }

  git(["add", "-A"], CACHE_DIR);

  // Check if there's anything to commit
  const status = git(["status", "--porcelain"], CACHE_DIR);
  if (!status) return null; // nothing to commit

  const commit = git(["commit", "-m", "sync: update pi settings"], CACHE_DIR);
  if (commit === null && !status) return null; // no changes, ok

  const push = git(["push", "origin", "main"], CACHE_DIR);
  if (push === null) return "Failed to push — check network or git credentials";

  return null;
}

export default async function (pi: ExtensionAPI) {
  // ── On startup: pull from GitHub and apply ──
  pi.on("session_start", async (_event, ctx) => {
    const err = cloneOrPull();
    if (err) {
      ctx.ui.notify(`pi-sync pull: ${err}`, "warn");
      return;
    }
    // Copy repo → local
    repoToLocal();
    ctx.ui.notify("pi-sync: pulled latest settings from GitHub", "info");
  });

  // ── /sync-push command: push local changes to GitHub ──
  pi.registerCommand("sync-push", {
    description: "Push pi settings/extensions/skills to GitHub",
    handler: async (_args, ctx) => {
      // Ensure we have the repo
      if (!isRepo()) {
        const err = cloneOrPull();
        if (err) {
          ctx.ui.notify(`pi-sync: ${err}`, "error");
          return;
        }
      }

      // Copy local → repo
      localToRepo();

      // Push
      const err = pushToRemote();
      if (err) {
        ctx.ui.notify(`pi-sync push: ${err}`, "error");
      } else {
        ctx.ui.notify("pi-sync: pushed to GitHub ✓", "success");
      }
    },
  });

  // ── /sync-pull command: force pull from GitHub ──
  pi.registerCommand("sync-pull", {
    description: "Pull pi settings/extensions/skills from GitHub",
    handler: async (_args, ctx) => {
      const err = cloneOrPull();
      if (err) {
        ctx.ui.notify(`pi-sync pull: ${err}`, "error");
        return;
      }
      repoToLocal();
      ctx.ui.notify("pi-sync: pulled from GitHub ✓", "success");
    },
  });

  // ── Auto-push on shutdown ──
  pi.on("session_shutdown", async (_event, _ctx) => {
    if (!isRepo()) return;
    localToRepo();
    pushToRemote();
  });
};
