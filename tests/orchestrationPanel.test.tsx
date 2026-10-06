// @vitest-environment jsdom
//
// The live panel lists running runs only, so a run leaves its input the
// moment it pauses, stops or finishes. The line it settles to must say which
// — from the run as it is now — rather than guess from the last running
// snapshot, which can only ever conclude "done".

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { act, render, screen, cleanup } from "@testing-library/react";
import OrchestrationPanel from "@renderer/views/chat/OrchestrationPanel";
import {
  groupTranscript,
  activeRuns,
  type WorkflowRun,
} from "@renderer/views/chat/transcript/orchestration";
import { resetWire, workflowCard, type CardRun } from "./wire";

beforeEach(() => {
  resetWire();
  cleanup();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Past the hold, when the run has folded to its one settled line. */
function settle(): void {
  act(() => {
    vi.advanceTimersByTime(2000);
  });
}

const base: CardRun = {
  runId: "wf_1",
  name: "audit-auth",
  phases: [{ title: "Scan" }],
  agents: [
    { instance: "scan#1", task: "scan a", phase: "Scan", status: "success" },
  ],
};

function byId(
  card: CardRun,
  o: { continuedIn?: string } = {},
): Map<string, WorkflowRun> {
  const out = new Map<string, WorkflowRun>();
  for (const row of groupTranscript([workflowCard(card, o)])) {
    if (row.kind === "run") out.set(row.run.tool.id, row.run);
  }
  return out;
}

function live(card: CardRun): WorkflowRun[] {
  return activeRuns(groupTranscript([workflowCard(card)]));
}

describe("the live panel settling a run", () => {
  it("says a run that paused is waiting, not done", () => {
    const view = render(
      <OrchestrationPanel
        runs={live({ ...base, status: "running" })}
        onClose={() => {}}
      />,
    );
    const paused = {
      ...base,
      status: "paused",
      checkpointId: "cp-1",
      waiting: "which findings?",
    };
    view.rerender(
      <OrchestrationPanel
        runs={[]}
        current={byId(paused)}
        onClose={() => {}}
      />,
    );
    settle();
    expect(screen.getByText(/Waiting — which findings\?/)).toBeTruthy();
    expect(screen.queryByText(/^1 done$/)).toBeNull();
  });

  it("without the current state, still falls back to the last snapshot", () => {
    const view = render(
      <OrchestrationPanel
        runs={live({ ...base, status: "running" })}
        onClose={() => {}}
      />,
    );
    view.rerender(<OrchestrationPanel runs={[]} onClose={() => {}} />);
    settle();
    expect(screen.getByText(/1 done/)).toBeTruthy();
  });

  it("says a run that was stopped is stopped, with the reason", () => {
    const view = render(
      <OrchestrationPanel
        runs={live({ ...base, status: "running" })}
        onClose={() => {}}
      />,
    );
    const stopped = {
      ...base,
      status: "stopped",
      stopReason: "at the orchestrator’s request",
    };
    view.rerender(
      <OrchestrationPanel
        runs={[]}
        current={byId(stopped)}
        onClose={() => {}}
      />,
    );
    settle();
    expect(
      screen.getByText(/Stopped — at the orchestrator’s request/),
    ).toBeTruthy();
  });
});
