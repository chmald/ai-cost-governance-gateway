import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App, Workspace } from "./App";
import { ApiError } from "./api";
import { createAuth } from "./auth";
import { session, testApi } from "./test/fixtures";

vi.mock("./auth", () => ({ createAuth: vi.fn() }));

describe("workspace permissions and truthful state", () => {
  it("shows settled, reserved, and available dollars with the cap caveat and UTC month", async () => {
    render(<Workspace api={testApi()} config={{ mode: "demo" }} session={session} />);
    expect(await screen.findByText("$10.00")).toBeVisible();
    expect(screen.getByText("$1.00")).toBeVisible();
    expect(screen.getByText("$2.00")).toBeVisible();
    expect(screen.getByText("$7.00")).toBeVisible();
    expect(screen.getByText("Not an Azure invoice cap.")).toBeVisible();
    expect(screen.getByText("September 2026 · UTC month")).toBeVisible();
    expect(screen.getByText("DEMO MODE")).toBeVisible();
  });
  it("does not show admin mutation controls to readers", async () => {
    const user = userEvent.setup();
    render(<Workspace api={testApi()} config={{ mode: "demo" }}
      session={{ ...session, user: { ...session.user, roles: ["Gateway.Reader"] } }} />);
    await user.click(screen.getByRole("button", { name: "Teams & budgets" }));
    expect(await screen.findByText("Engineering")).toBeVisible();
    expect(screen.getByText(/Read-only access/)).toBeVisible();
    expect(screen.queryByRole("button", { name: /Create team/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Edit Engineering/ })).not.toBeInTheDocument();
  });
  it("shows user-only accounts the playground rather than a forbidden overview", async () => {
    const api = testApi();
    render(<Workspace api={api} config={{ mode: "demo" }}
      session={{ ...session, user: { ...session.user, roles: ["Gateway.User"] } }} />);
    expect(await screen.findByLabelText("Team")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Teams & budgets" })).not.toBeInTheDocument();
    expect(api.overview).not.toHaveBeenCalled();
  });
  it("shows disconnected state, not made-up overview metrics", async () => {
    const api = testApi({ overview: vi.fn().mockRejectedValue(new ApiError(0, "DISCONNECTED", "Cannot reach the gateway.")) });
    render(<Workspace api={api} config={{ mode: "demo" }} session={session} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Cannot reach the gateway");
    expect(screen.queryByText("$10.00")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try loading again" })).toBeVisible();
  });
});

describe("public configuration and explicit sign-in", () => {
  beforeEach(() => vi.mocked(createAuth).mockReset());
  it("never assumes demo mode when public configuration is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Disconnected")));
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Gateway unavailable" })).toBeVisible();
    expect(screen.queryByText("DEMO MODE")).not.toBeInTheDocument();
    expect(createAuth).not.toHaveBeenCalled();
  });
  it("does not auto-login, and opens authentication only on explicit sign-in", async () => {
    const signIn = vi.fn(async () => undefined);
    vi.mocked(createAuth).mockResolvedValue({
      signIn, getToken: async () => "test-token", signOut: async () => undefined,
    });
    const fetcher = vi.fn(async (url: string) => {
      const payload = url === "/api/config"
        ? { mode: "azure", auth: { tenantId: "tenant", clientId: "client", apiScope: "scope" } }
        : { error: { code: "FORBIDDEN", message: "No gateway role is assigned." } };
      return new Response(JSON.stringify(payload), { status: url === "/api/config" ? 200 : 403 });
    });
    vi.stubGlobal("fetch", fetcher);
    const user = userEvent.setup();
    render(<App />);
    const button = await screen.findByRole("button", { name: "Sign in with Microsoft" });
    expect(signIn).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
    await user.click(button);
    expect(await screen.findByRole("alert")).toHaveTextContent("No gateway role is assigned.");
    await waitFor(() => expect(signIn).toHaveBeenCalledOnce());
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("DEMO MODE")).not.toBeInTheDocument();
  });
  it("rejects a mismatched session mode rather than displaying a false demo banner", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(
      url === "/api/config" ? { mode: "demo" } : { ...session, mode: "azure" },
    ))));
    render(<App />);
    expect(await screen.findByRole("alert")).toHaveTextContent("mismatched session");
    expect(screen.queryByText("DEMO MODE")).not.toBeInTheDocument();
  });
});
