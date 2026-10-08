import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import { TeamForm } from "./pages/Teams";
import { ModelForm } from "./pages/Models";
import { McpForm } from "./pages/Mcp";
import { model, team, testApi, userId } from "./test/fixtures";

describe("team budget form", () => {
  it("submits exact microdollars and explicit membership/model choices", async () => {
    const api = testApi();
    const saved = vi.fn();
    const user = userEvent.setup();
    render(<TeamForm api={api} models={[model]} onCancel={vi.fn()} onSaved={saved} />);
    await user.type(screen.getByLabelText(/Team ID/), "research");
    await user.type(screen.getByLabelText("Team name"), "Research");
    await user.type(screen.getByLabelText(/Monthly budget/), "0.100001");
    await user.type(screen.getByLabelText(/Member object IDs/), userId);
    await user.click(screen.getByRole("checkbox", { name: /Model Alpha/ }));
    await user.click(screen.getByRole("button", { name: "Create team" }));
    await waitFor(() => expect(saved).toHaveBeenCalledOnce());
    expect(api.createTeam).toHaveBeenCalledWith({
      id: "research", name: "Research", monthlyBudgetMicros: 100_001,
      allowedModels: ["model-a"], principals: [userId], applications: [],
    });
  });
  it("registers app-only application identities separately from user members", async () => {
    const api = testApi();
    const user = userEvent.setup();
    const appId = "00000000-0000-4000-8000-0000000000aa";
    render(<TeamForm api={api} models={[model]} team={team} onCancel={vi.fn()} onSaved={vi.fn()} />);
    await user.type(screen.getByLabelText(/Application identity object IDs/), appId);
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(api.updateTeam).toHaveBeenCalledWith("engineering", {
      name: "Engineering", monthlyBudgetMicros: 10_000_000,
      allowedModels: ["model-a"], principals: [userId], applications: [appId],
    }));
  });
  it("rejects an object ID listed as both a member and an application identity", async () => {
    const api = testApi();
    const user = userEvent.setup();
    render(<TeamForm api={api} models={[model]} team={team} onCancel={vi.fn()} onSaved={vi.fn()} />);
    await user.type(screen.getByLabelText(/Application identity object IDs/), userId.toUpperCase());
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(screen.getByRole("alert")).toHaveTextContent("both a user member and an application identity");
    expect(api.updateTeam).not.toHaveBeenCalled();
  });
  it("shows amount validation errors and never calls the API with rounded money", async () => {
    const api = testApi();
    const user = userEvent.setup();
    render(<TeamForm api={api} models={[model]} team={team} onCancel={vi.fn()} onSaved={vi.fn()} />);
    await user.clear(screen.getByLabelText(/Monthly budget/));
    await user.type(screen.getByLabelText(/Monthly budget/), "0.0000009");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(screen.getByRole("alert")).toHaveTextContent("no more than 6 decimal places");
    expect(api.updateTeam).not.toHaveBeenCalled();
  });
  it("retains form values and surfaces a forbidden response without false success", async () => {
    const api = testApi({ updateTeam: vi.fn().mockRejectedValue(new ApiError(403, "FORBIDDEN", "Administrator role required.")) });
    const saved = vi.fn();
    const user = userEvent.setup();
    render(<TeamForm api={api} models={[model]} team={team} onCancel={vi.fn()} onSaved={saved} />);
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Access denied. Administrator role required.");
    expect(screen.getByLabelText("Team name")).toHaveValue("Engineering");
    expect(saved).not.toHaveBeenCalled();
    expect(api.updateTeam).toHaveBeenCalledWith("engineering", {
      name: "Engineering", monthlyBudgetMicros: 10_000_000,
      allowedModels: ["model-a"], principals: [userId], applications: [],
    });
  });
  it("rejects email addresses where member object IDs are required", async () => {
    const api = testApi();
    const user = userEvent.setup();
    render(<TeamForm api={api} models={[model]} team={team} onCancel={vi.fn()} onSaved={vi.fn()} />);
    await user.clear(screen.getByLabelText(/Member object IDs/));
    await user.type(screen.getByLabelText(/Member object IDs/), "someone@example.com");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(screen.getByRole("alert")).toHaveTextContent("valid Entra object ID");
    expect(api.updateTeam).not.toHaveBeenCalled();
  });
});

describe("model governance form", () => {
  function completeNewModel() {
    fireEvent.change(screen.getByLabelText(/Model ID/), { target: { value: "new-model" } });
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "New model" } });
    fireEvent.change(screen.getByLabelText("Deployment name"), { target: { value: "new-deployment" } });
    fireEvent.change(screen.getByLabelText(/Foundry model name/), { target: { value: "gpt-4o-mini" } });
    fireEvent.change(screen.getByLabelText(/Model version/), { target: { value: "2024-07-18" } });
    fireEvent.change(screen.getByLabelText(/Capacity/), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText(/Input price/), { target: { value: "0.15" } });
    fireEvent.change(screen.getByLabelText(/Output price/), { target: { value: "0.6" } });
    fireEvent.change(screen.getByLabelText(/Context window/), { target: { value: "128000" } });
    fireEvent.change(screen.getByLabelText(/Maximum output/), { target: { value: "4096" } });
    fireEvent.change(screen.getByLabelText(/Pricing valid until/), { target: { value: "2099-01-01T00:00" } });
  }
  it("offers only supported on-demand SKUs and creates deployments disabled by default", async () => {
    const api = testApi();
    const user = userEvent.setup();
    render(<ModelForm api={api} demo onCancel={vi.fn()} onSaved={vi.fn()} />);
    const select = screen.getByRole("combobox", { name: /Deployment SKU/ });
    expect(within(select).getAllByRole("option").map((option) => option.getAttribute("value"))).toEqual([
      "", "Standard", "GlobalStandard", "DataZoneStandard",
    ]);
    completeNewModel();
    await user.selectOptions(select, "GlobalStandard");
    expect(screen.getByRole("checkbox", { name: /Enable for new requests/ })).not.toBeChecked();
    await user.click(screen.getByRole("button", { name: "Create demo deployment" }));
    await waitFor(() => expect(api.createModel).toHaveBeenCalledOnce());
    expect(api.createModel).toHaveBeenCalledWith(expect.objectContaining({
      sku: "GlobalStandard", enabled: false, inputPriceMicrosPerMillion: 150_000,
      outputPriceMicrosPerMillion: 600_000,
    }));
  });
  it("rejects an unsupported SKU even if injected into the browser form", async () => {
    const api = testApi();
    const user = userEvent.setup();
    render(<ModelForm api={api} demo onCancel={vi.fn()} onSaved={vi.fn()} />);
    completeNewModel();
    const select = screen.getByRole("combobox", { name: /Deployment SKU/ }) as HTMLSelectElement;
    select.add(new Option("ProvisionedManaged", "ProvisionedManaged"));
    await user.selectOptions(select, "ProvisionedManaged");
    await user.click(screen.getByRole("button", { name: "Create demo deployment" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Provisioned throughput cannot use this token-only budget ledger");
    expect(api.createModel).not.toHaveBeenCalled();
  });
  it("submits exact prices, UTC expiration, and disabled state with no identity mutation", async () => {
    const api = testApi();
    const saved = vi.fn();
    const user = userEvent.setup();
    render(<ModelForm api={api} model={model} demo onCancel={vi.fn()} onSaved={saved} />);
    await user.clear(screen.getByLabelText(/Input price/));
    await user.type(screen.getByLabelText(/Input price/), "0.123456");
    await user.click(screen.getByRole("checkbox", { name: /Enable for new requests/ }));
    await user.click(screen.getByRole("button", { name: "Save governance" }));
    await waitFor(() => expect(saved).toHaveBeenCalledOnce());
    expect(api.updateModel).toHaveBeenCalledWith("model-a", {
      displayName: "Model Alpha", inputPriceMicrosPerMillion: 123_456,
      outputPriceMicrosPerMillion: 600_000, contextWindowTokens: 128_000,
      maxOutputTokens: 4_096, pricingValidUntil: "2099-01-01T00:00:00.000Z", enabled: false,
    });
  });
  it("rejects expired pricing for an enabled model", async () => {
    const api = testApi();
    const user = userEvent.setup();
    render(<ModelForm api={api} model={model} demo onCancel={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/Pricing valid until/), { target: { value: "2020-01-01T00:00" } });
    await user.click(screen.getByRole("button", { name: "Save governance" }));
    expect(screen.getByRole("alert")).toHaveTextContent("in the future");
    expect(api.updateModel).not.toHaveBeenCalled();
  });
});

describe("MCP registration", () => {
  it("submits a registry request without tokens or cloud credentials", async () => {
    const api = testApi();
    const saved = vi.fn();
    const user = userEvent.setup();
    render(<McpForm api={api} demo onCancel={vi.fn()} onSaved={saved} />);
    await user.type(screen.getByLabelText("Server ID"), "knowledge");
    await user.type(screen.getByLabelText("Server name"), "Knowledge");
    await user.type(screen.getByLabelText(/Gateway path/), "mcp/knowledge");
    await user.type(screen.getByLabelText(/Backend URL/), "https://tools.example.com/mcp");
    await user.type(screen.getByLabelText(/Authentication audience/), "api://knowledge");
    await user.click(screen.getByRole("button", { name: "Register demo server" }));
    await waitFor(() => expect(saved).toHaveBeenCalledOnce());
    expect(api.createMcp).toHaveBeenCalledWith({
      id: "knowledge", name: "Knowledge", path: "mcp/knowledge",
      backendUrl: "https://tools.example.com/mcp", authAudience: "api://knowledge",
    });
  });
  it("rejects secrets embedded in a backend URL", async () => {
    const api = testApi();
    const user = userEvent.setup();
    render(<McpForm api={api} demo onCancel={vi.fn()} onSaved={vi.fn()} />);
    await user.type(screen.getByLabelText(/Backend URL/), "https://tools.example.com/mcp?token=not-allowed");
    await user.click(screen.getByRole("button", { name: "Register demo server" }));
    expect(screen.getByRole("alert")).toHaveTextContent("without credentials, query parameters, or a fragment");
    expect(api.createMcp).not.toHaveBeenCalled();
  });
});
