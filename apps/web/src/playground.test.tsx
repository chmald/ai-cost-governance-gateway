import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import { PlaygroundPage } from "./pages/Playground";
import { session, team, testApi } from "./test/fixtures";

describe("text playground", () => {
  it("submits one non-streaming request and displays charged microdollars correctly", async () => {
    const api = testApi();
    const user = userEvent.setup();
    render(<PlaygroundPage api={api} session={session} demo />);
    await user.selectOptions(await screen.findByLabelText("Team"), "engineering");
    await user.selectOptions(screen.getByLabelText("Model"), "model-a");
    await user.type(screen.getByLabelText(/Prompt/), "Hello gateway");
    await user.click(screen.getByRole("button", { name: "Run demo request" }));
    expect(await screen.findByText("Simulated response.")).toBeVisible();
    expect(screen.getByText("$0.000006")).toBeVisible();
    expect(api.chat).toHaveBeenCalledExactlyOnceWith({
      teamId: "engineering", modelId: "model-a",
      messages: [{ role: "user", content: "Hello gateway" }], maxCompletionTokens: 256,
    });
    expect(screen.getByText(/No prompt is sent to Foundry/)).toBeVisible();
  });
  it("surfaces uncertainty and never automatically repeats inference", async () => {
    const api = testApi({
      chat: vi.fn().mockRejectedValue(new ApiError(503, "INFERENCE_UNCERTAIN", "The outcome is uncertain; the reservation remains held.")),
    });
    const user = userEvent.setup();
    render(<PlaygroundPage api={api} session={session} demo />);
    await user.selectOptions(await screen.findByLabelText("Team"), "engineering");
    await user.selectOptions(screen.getByLabelText("Model"), "model-a");
    await user.type(screen.getByLabelText(/Prompt/), "A request");
    await user.click(screen.getByRole("button", { name: "Run demo request" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("reservation remains held");
    expect(api.chat).toHaveBeenCalledOnce();
    expect(screen.getByLabelText(/Prompt/)).toHaveValue("A request");
  });
  it("requires member assignment even for an administrator", async () => {
    const api = testApi({ teams: vi.fn(async () => [{ ...team, principals: [] }]) });
    render(<PlaygroundPage api={api} session={session} demo />);
    expect(await screen.findByRole("heading", { name: "No team membership" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Run demo request" })).not.toBeInTheDocument();
    expect(api.chat).not.toHaveBeenCalled();
  });
  it("blocks output-token values beyond the model limit before submission", async () => {
    const api = testApi();
    const user = userEvent.setup();
    render(<PlaygroundPage api={api} session={session} demo />);
    await user.selectOptions(await screen.findByLabelText("Team"), "engineering");
    await user.selectOptions(screen.getByLabelText("Model"), "model-a");
    await user.type(screen.getByLabelText(/Prompt/), "A request");
    await user.clear(screen.getByLabelText(/Maximum completion tokens/));
    await user.type(screen.getByLabelText(/Maximum completion tokens/), "4097");
    await user.click(screen.getByRole("button", { name: "Run demo request" }));
    expect(screen.getByRole("alert")).toHaveTextContent("4,096 token output limit");
    expect(api.chat).not.toHaveBeenCalled();
  });
  it("does not fetch chat controls for a reader-only session", async () => {
    const api = testApi();
    render(<PlaygroundPage api={api} session={{ ...session, user: { ...session.user, roles: ["Gateway.Reader"] } }} demo />);
    await waitFor(() => expect(screen.getByText("Inference access required")).toBeVisible());
    expect(api.teams).not.toHaveBeenCalled();
    expect(api.chat).not.toHaveBeenCalled();
  });
  it("demo mode can simulate the app-only agent against teams that register it", async () => {
    const agent = { id: "00000000-0000-4000-8000-0000000000aa", name: "Demo agent", clientAppId: "00000000-0000-4000-8000-0000000000bb" };
    const api = testApi({ teams: vi.fn(async () => [team, { ...team, id: "agents", name: "Agents", principals: [], applications: [agent.id] }]) });
    const user = userEvent.setup();
    render(<PlaygroundPage api={api} session={{ ...session, demoAgent: agent }} demo />);
    await user.click(await screen.findByRole("checkbox", { name: /demo agent identity/ }));
    const teamSelect = screen.getByLabelText("Team");
    expect(Array.from((teamSelect as HTMLSelectElement).options).map((option) => option.value)).toEqual(["", "agents"]);
    await user.selectOptions(teamSelect, "agents");
    await user.selectOptions(screen.getByLabelText("Model"), "model-a");
    await user.type(screen.getByLabelText(/Prompt/), "Agent request");
    await user.click(screen.getByRole("button", { name: "Run demo request" }));
    expect(api.chat).toHaveBeenCalledExactlyOnceWith({
      teamId: "agents", modelId: "model-a",
      messages: [{ role: "user", content: "Agent request" }], maxCompletionTokens: 256, simulateAgent: true,
    });
  });
  it("never offers agent simulation outside the local demo", async () => {
    const api = testApi();
    const agent = { id: "00000000-0000-4000-8000-0000000000aa", name: "Demo agent", clientAppId: "00000000-0000-4000-8000-0000000000bb" };
    render(<PlaygroundPage api={api} session={{ ...session, mode: "azure", demoAgent: agent }} demo={false} />);
    await screen.findByLabelText("Team");
    expect(screen.queryByRole("checkbox", { name: /demo agent identity/ })).not.toBeInTheDocument();
  });
  it("renders server text literally rather than executing markup", async () => {
    const api = testApi({
      chat: vi.fn(async () => ({
        id: "response-x", content: "<img src=x onerror=alert(1)>",
        usage: { promptTokens: 1, completionTokens: 1, chargedMicros: 1 },
      })),
    });
    const user = userEvent.setup();
    render(<PlaygroundPage api={api} session={session} demo />);
    await user.selectOptions(await screen.findByLabelText("Team"), "engineering");
    await user.selectOptions(screen.getByLabelText("Model"), "model-a");
    await user.type(screen.getByLabelText(/Prompt/), "A request");
    await user.click(screen.getByRole("button", { name: "Run demo request" }));
    expect(await screen.findByText("<img src=x onerror=alert(1)>")).toBeVisible();
    expect(document.querySelector(".response-content img")).toBeNull();
  });
});
