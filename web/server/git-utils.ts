import { execSync } from "node:child_process";
import { basename } from "node:path";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface GitRepoInfo {
  repoRoot: string;
  repoName: string;
  currentBranch: string;
  defaultBranch: string;
}

export interface GitBranchInfo {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
  ahead: number;
  behind: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, {
    cwd,
    encoding: "utf-8",
    timeout: 10_000,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function gitSafe(cmd: string, cwd: string): string | null {
  try {
    return git(cmd, cwd);
  } catch {
    return null;
  }
}

// ─── Functions ──────────────────────────────────────────────────────────────

export function getRepoInfo(cwd: string): GitRepoInfo | null {
  const repoRoot = gitSafe("rev-parse --show-toplevel", cwd);
  if (!repoRoot) return null;

  const currentBranch = gitSafe("rev-parse --abbrev-ref HEAD", cwd) || "HEAD";
  const defaultBranch = resolveDefaultBranch(repoRoot);

  return {
    repoRoot,
    repoName: basename(repoRoot),
    currentBranch,
    defaultBranch,
  };
}

function resolveDefaultBranch(repoRoot: string): string {
  // Try origin HEAD
  const originRef = gitSafe("symbolic-ref refs/remotes/origin/HEAD", repoRoot);
  if (originRef) {
    return originRef.replace("refs/remotes/origin/", "");
  }
  // Fallback: check if main or master exists
  const branches = gitSafe("branch --list main master", repoRoot) || "";
  if (branches.includes("main")) return "main";
  if (branches.includes("master")) return "master";
  // Last resort
  return "main";
}

export function listBranches(repoRoot: string): GitBranchInfo[] {
  const result: GitBranchInfo[] = [];

  // Local branches
  const localRaw = gitSafe(
    "for-each-ref '--format=%(refname:short)%09%(HEAD)' refs/heads/",
    repoRoot,
  );
  if (localRaw) {
    for (const line of localRaw.split("\n")) {
      if (!line.trim()) continue;
      const [name, head] = line.split("\t");
      const isCurrent = head?.trim() === "*";
      const { ahead, behind } = getBranchStatus(repoRoot, name);
      result.push({
        name,
        isCurrent,
        isRemote: false,
        ahead,
        behind,
      });
    }
  }

  // Remote branches (only those without a local counterpart)
  const localNames = new Set(result.map((b) => b.name));
  const remoteRaw = gitSafe(
    "for-each-ref '--format=%(refname:short)' refs/remotes/origin/",
    repoRoot,
  );
  if (remoteRaw) {
    for (const line of remoteRaw.split("\n")) {
      const full = line.trim();
      if (!full || full === "origin/HEAD") continue;
      const name = full.replace("origin/", "");
      if (localNames.has(name)) continue;
      result.push({
        name,
        isCurrent: false,
        isRemote: true,
        ahead: 0,
        behind: 0,
      });
    }
  }

  return result;
}

export function gitFetch(cwd: string): { success: boolean; output: string } {
  try {
    const output = git("fetch --prune", cwd);
    return { success: true, output };
  } catch (e: unknown) {
    return { success: false, output: e instanceof Error ? e.message : String(e) };
  }
}

export function gitPull(
  cwd: string,
): { success: boolean; output: string } {
  try {
    const output = git("pull", cwd);
    return { success: true, output };
  } catch (e: unknown) {
    return { success: false, output: e instanceof Error ? e.message : String(e) };
  }
}

export function checkoutBranch(cwd: string, branchName: string): void {
  git(`checkout ${branchName}`, cwd);
}

export function getBranchStatus(
  repoRoot: string,
  branchName: string,
): { ahead: number; behind: number } {
  const raw = gitSafe(
    `rev-list --left-right --count origin/${branchName}...${branchName}`,
    repoRoot,
  );
  if (!raw) return { ahead: 0, behind: 0 };
  const [behind, ahead] = raw.split(/\s+/).map(Number);
  return { ahead: ahead || 0, behind: behind || 0 };
}
