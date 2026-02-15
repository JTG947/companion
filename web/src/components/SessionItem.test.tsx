// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { SessionItem } from "./SessionItem.js";
import type { SessionItem as SessionItemType } from "../utils/project-grouping.js";

const clearRecentlyRenamed = vi.fn();

vi.mock("../store.js", () => ({
  useStore: {
    getState: () => ({
      clearRecentlyRenamed,
    }),
  },
}));

function makeSession(overrides: Partial<SessionItemType> = {}): SessionItemType {
  return {
    id: "s1",
    model: "claude-sonnet-4-5-20250929",
    cwd: "/tmp/project",
    gitBranch: "",
    isWorktree: false,
    gitAhead: 0,
    gitBehind: 0,
    linesAdded: 0,
    linesRemoved: 0,
    isConnected: true,
    status: "idle",
    sdkState: "connected",
    createdAt: Date.now(),
    archived: false,
    backendType: "claude",
    repoRoot: "/tmp/project",
    permCount: 0,
    ...overrides,
  };
}

describe("SessionItem", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("clears recently renamed state when name animation ends", () => {
    const session = makeSession();

    render(
      <SessionItem
        session={session}
        isActive={false}
        sessionName="Animated Name"
        permCount={0}
        isRecentlyRenamed={true}
        onSelect={vi.fn()}
        onStartRename={vi.fn()}
        onArchive={vi.fn()}
        onUnarchive={vi.fn()}
        onDelete={vi.fn()}
        editingSessionId={null}
        editingName=""
        setEditingName={vi.fn()}
        onConfirmRename={vi.fn()}
        onCancelRename={vi.fn()}
        editInputRef={{ current: null }}
      />,
    );

    // We fire a generic animationend event on the exact span that owns
    // the onAnimationEnd handler to avoid flaky bubbling assumptions.
    const nameEl = screen.getByText("Animated Name");
    fireEvent(nameEl, new Event("animationend", { bubbles: true }));

    expect(clearRecentlyRenamed).toHaveBeenCalledWith("s1");
  });
});
