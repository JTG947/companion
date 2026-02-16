import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Hoisted mocks ───────────────────────────────────────────────────────────

const mockHomedir = vi.hoisted(() => {
  let dir = "/fake/home";
  return { get: () => dir, set: (d: string) => { dir = d; } };
});

const mockExecSync = vi.hoisted(() => vi.fn());
const mockExistsSync = vi.hoisted(() => vi.fn());
const mockMkdirSync = vi.hoisted(() => vi.fn());

vi.mock("node:os", () => ({ homedir: () => mockHomedir.get() }));
vi.mock("node:child_process", () => ({ execSync: mockExecSync }));
vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
  mkdirSync: mockMkdirSync,
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mockGitCommand(pattern: string | RegExp, result: string) {
  mockExecSync.mockImplementation((cmd: string) => {
    if (typeof pattern === "string" ? cmd.includes(pattern) : pattern.test(cmd)) {
      return result;
    }
    throw new Error(`Unexpected git command: ${cmd}`);
  });
}

function mockGitCommands(map: Record<string, string | Error>) {
  mockExecSync.mockImplementation((cmd: string) => {
    for (const [pattern, result] of Object.entries(map)) {
      if (cmd.includes(pattern)) {
        if (result instanceof Error) throw result;
        return result;
      }
    }
    throw new Error(`Unmocked git command: ${cmd}`);
  });
}

// ─── Dynamic import with module reset ────────────────────────────────────────

let gitUtils: typeof import("./git-utils.js");

beforeEach(async () => {
  vi.resetModules();
  mockExecSync.mockReset();
  mockExistsSync.mockReset();
  mockMkdirSync.mockReset();
  mockHomedir.set("/fake/home");
  gitUtils = await import("./git-utils.js");
});

// ─── getRepoInfo ─────────────────────────────────────────────────────────────

describe("getRepoInfo", () => {
  it("returns null for a non-git directory", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("fatal: not a git repository");
    });

    const result = gitUtils.getRepoInfo("/tmp/not-a-repo");
    expect(result).toBeNull();
  });

  it("returns correct repo info for a standard git repo", () => {
    mockGitCommands({
      "rev-parse --show-toplevel": "/home/user/my-project",
      "rev-parse --abbrev-ref HEAD": "feat/cool-feature",
      "rev-parse --git-dir": ".git",
      "symbolic-ref refs/remotes/origin/HEAD": "refs/remotes/origin/main",
    });

    const result = gitUtils.getRepoInfo("/home/user/my-project");
    expect(result).toEqual({
      repoRoot: "/home/user/my-project",
      repoName: "my-project",
      currentBranch: "feat/cool-feature",
      defaultBranch: "main",
    });
  });

  it("falls back to 'HEAD' when branch detection fails", () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --show-toplevel")) return "/repo";
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) throw new Error("detached HEAD");
      if (cmd.includes("rev-parse --git-dir")) return ".git";
      if (cmd.includes("symbolic-ref refs/remotes/origin/HEAD")) return "refs/remotes/origin/main";
      throw new Error(`Unmocked: ${cmd}`);
    });

    const result = gitUtils.getRepoInfo("/repo");
    expect(result).not.toBeNull();
    expect(result!.currentBranch).toBe("HEAD");
  });

  it("resolves default branch via origin HEAD", () => {
    mockGitCommands({
      "rev-parse --show-toplevel": "/repo",
      "rev-parse --abbrev-ref HEAD": "develop",
      "rev-parse --git-dir": ".git",
      "symbolic-ref refs/remotes/origin/HEAD": "refs/remotes/origin/develop",
    });

    const result = gitUtils.getRepoInfo("/repo");
    expect(result!.defaultBranch).toBe("develop");
  });

  it("falls back to 'main' when origin HEAD and master are unavailable", () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --show-toplevel")) return "/repo";
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return "feature";
      if (cmd.includes("rev-parse --git-dir")) return ".git";
      if (cmd.includes("symbolic-ref refs/remotes/origin/HEAD")) throw new Error("no origin");
      if (cmd.includes("branch --list main master")) return "";
      throw new Error(`Unmocked: ${cmd}`);
    });

    const result = gitUtils.getRepoInfo("/repo");
    expect(result!.defaultBranch).toBe("main");
  });

  it("falls back to 'master' when origin HEAD fails and only master exists", () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --show-toplevel")) return "/repo";
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return "feature";
      if (cmd.includes("rev-parse --git-dir")) return ".git";
      if (cmd.includes("symbolic-ref refs/remotes/origin/HEAD")) throw new Error("no origin");
      if (cmd.includes("branch --list main master")) return "  master";
      throw new Error(`Unmocked: ${cmd}`);
    });

    const result = gitUtils.getRepoInfo("/repo");
    expect(result!.defaultBranch).toBe("master");
  });
});

// ─── listBranches ────────────────────────────────────────────────────────────

describe("listBranches", () => {
  it("parses local branches with current marker", () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("worktree list --porcelain")) return "";
      if (cmd.includes("for-each-ref") && cmd.includes("refs/heads/")) {
        return "main\t*\nfeat/login\t ";
      }
      if (cmd.includes("for-each-ref") && cmd.includes("refs/remotes/origin/")) return "";
      if (cmd.includes("rev-list --left-right --count")) return "0\t0";
      throw new Error(`Unmocked: ${cmd}`);
    });

    const branches = gitUtils.listBranches("/repo");
    const main = branches.find((b) => b.name === "main");
    const feat = branches.find((b) => b.name === "feat/login");

    expect(main).toBeDefined();
    expect(main!.isCurrent).toBe(true);
    expect(main!.isRemote).toBe(false);

    expect(feat).toBeDefined();
    expect(feat!.isCurrent).toBe(false);
  });

  it("includes remote-only branches", () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("worktree list --porcelain")) return "";
      if (cmd.includes("for-each-ref") && cmd.includes("refs/heads/")) {
        return "main\t*";
      }
      if (cmd.includes("for-each-ref") && cmd.includes("refs/remotes/origin/")) {
        return "origin/feat/remote-branch";
      }
      if (cmd.includes("rev-list --left-right --count")) return "0\t0";
      throw new Error(`Unmocked: ${cmd}`);
    });

    const branches = gitUtils.listBranches("/repo");
    const remote = branches.find((b) => b.name === "feat/remote-branch");

    expect(remote).toBeDefined();
    expect(remote!.isRemote).toBe(true);
    expect(remote!.isCurrent).toBe(false);
    expect(remote!.ahead).toBe(0);
    expect(remote!.behind).toBe(0);
  });

  it("excludes origin/HEAD from remote branches", () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("worktree list --porcelain")) return "";
      if (cmd.includes("for-each-ref") && cmd.includes("refs/heads/")) return "";
      if (cmd.includes("for-each-ref") && cmd.includes("refs/remotes/origin/")) {
        return "origin/HEAD\norigin/main";
      }
      if (cmd.includes("rev-list --left-right --count")) return "0\t0";
      throw new Error(`Unmocked: ${cmd}`);
    });

    const branches = gitUtils.listBranches("/repo");
    expect(branches.find((b) => b.name === "HEAD")).toBeUndefined();
    expect(branches.find((b) => b.name === "main")).toBeDefined();
  });

  it("includes ahead/behind counts for local branches", () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("worktree list --porcelain")) return "";
      if (cmd.includes("for-each-ref") && cmd.includes("refs/heads/")) {
        return "dev\t ";
      }
      if (cmd.includes("for-each-ref") && cmd.includes("refs/remotes/origin/")) return "";
      if (cmd.includes("rev-list --left-right --count")) return "3\t5";
      throw new Error(`Unmocked: ${cmd}`);
    });

    const branches = gitUtils.listBranches("/repo");
    const dev = branches.find((b) => b.name === "dev");
    expect(dev).toBeDefined();
    // In the source: [behind, ahead] = raw.split(...).map(Number)
    expect(dev!.ahead).toBe(5);
    expect(dev!.behind).toBe(3);
  });

  it("returns empty array on git failure", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("git failed");
    });

    const branches = gitUtils.listBranches("/repo");
    expect(branches).toEqual([]);
  });
});

// ─── getBranchStatus ─────────────────────────────────────────────────────────

describe("getBranchStatus", () => {
  it("parses ahead/behind counts correctly", () => {
    mockGitCommand("rev-list --left-right --count", "7\t12");

    const status = gitUtils.getBranchStatus("/repo", "feat/branch");
    // Source: [behind, ahead] = raw.split(...).map(Number)
    expect(status.ahead).toBe(12);
    expect(status.behind).toBe(7);
  });

  it("returns 0/0 when there is no upstream", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("no upstream configured");
    });

    const status = gitUtils.getBranchStatus("/repo", "local-only");
    expect(status.ahead).toBe(0);
    expect(status.behind).toBe(0);
  });

  it("handles zero ahead/behind", () => {
    mockGitCommand("rev-list --left-right --count", "0\t0");

    const status = gitUtils.getBranchStatus("/repo", "main");
    expect(status.ahead).toBe(0);
    expect(status.behind).toBe(0);
  });
});
