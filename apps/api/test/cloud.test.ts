import { test } from "node:test";
import assert from "node:assert/strict";
import { AzureCloud, type Fetcher } from "../src/cloud.js";
import { azureConfig, newModel, chat } from "./helpers.js";
import { simulated } from "../src/inference.js";
import { GatewayError } from "../src/errors.js";

const identity = { getToken: async (_scope: string) => ({ token: "test-managed-identity" }) };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

test("deployment ARM requests are pinned to configured existing account and version", async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  const scopes: string[] = [];
  const cloud = new AzureCloud(azureConfig(), (async (url, init) => {
    requests.push({ url: String(url), init });
    return json({ properties: { provisioningState: "Creating" } }, 202);
  }) as Fetcher, { getToken: async scope => { scopes.push(scope); return { token: "fake-mi" }; } });
  assert.equal(await cloud.createDeployment(newModel), "Creating");
  const request = requests[0]!;
  assert.ok(request.url.includes("/providers/Microsoft.CognitiveServices/accounts/test-account/deployments/new-chat?api-version=2025-06-01"));
  assert.equal(request.init!.method, "PUT");
  assert.equal(request.init!.redirect, "error");
  const body = JSON.parse(request.init!.body as string);
  assert.equal(body.properties.model.version, newModel.modelVersion);
  assert.equal(body.properties.versionUpgradeOption, "NoAutoUpgrade");
  assert.equal(body.sku.name, newModel.sku);
  assert.deepEqual(scopes, ["https://management.azure.com/.default"]);
});

test("provider call uses only managed identity, fixed endpoint, explicit output, and never retries", async () => {
  let calls = 0;
  const scopes: string[] = [];
  const cloud = new AzureCloud(azureConfig(), (async (url, init) => {
    calls++;
    assert.equal(String(url), "https://test-account.openai.azure.com/openai/v1/chat/completions");
    assert.equal(init!.redirect, "error");
    assert.equal(JSON.parse(init!.body as string).model, "actual-deployment");
    assert.equal(JSON.parse(init!.body as string).max_completion_tokens, chat.max_completion_tokens);
    return json({ error: { message: "provider refused" } }, 429);
  }) as Fetcher, { getToken: async scope => { scopes.push(scope); return { token: "fake-mi" }; } });
  await assert.rejects(cloud.infer(chat, "actual-deployment"));
  assert.equal(calls, 1);
  assert.deepEqual(scopes, ["https://cognitiveservices.azure.com/.default"]);
});

test("ARM errors never report succeeded or forward provider diagnostics", async () => {
  let calls = 0;
  const cloud = new AzureCloud(azureConfig(), (async () => {
    calls++;
    return json({ error: "sensitive internal diagnostic" }, 403);
  }) as Fetcher, identity);
  await assert.rejects(cloud.createDeployment(newModel), (error: unknown) =>
    error instanceof GatewayError && error.code === "AZURE_CONTROL_PLANE_FAILED" && !error.message.includes("sensitive"));
  assert.equal(calls, 1);
});

test("MCP stays locked until JWT and outbound MI policy is installed, streamable type pinned", async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  const input = { id: "trusted", name: "Trusted MCP", path: "mcp/trusted",
    backendUrl: "https://tools.example.com/mcp", authAudience: "api://trusted-tools" };
  const cloud = new AzureCloud(azureConfig(), (async (url, init) => {
    requests.push({ url: String(url), init });
    return json({ properties: { provisioningState: "Succeeded" } });
  }) as Fetcher, identity);
  assert.equal(await cloud.registerMcp(input), "Succeeded");
  assert.equal(requests.length, 4);
  assert.ok(requests.every(r => r.url.includes("api-version=2025-09-01-preview")));
  const create = JSON.parse(requests[0]!.init!.body as string).properties;
  assert.equal(create.type, "mcp");
  assert.equal(create.mcpProperties.transportType, "streamable");
  assert.equal(create.serviceUrl, "https://tools.example.com");
  assert.deepEqual(create.mcpProperties.endpoints, [{ name: "message", uriTemplate: "/mcp" }]);
  assert.ok(requests.every(request => request.url.includes("/apis/external-mcp-trusted")));
  assert.equal(create.subscriptionRequired, true);
  const policy = JSON.parse(requests[2]!.init!.body as string).properties.value as string;
  assert.ok(policy.includes("Gateway.User") && policy.includes("authentication-managed-identity"));
  assert.ok(policy.includes('follow-redirects="false"'));
  assert.ok(policy.includes('<set-backend-service base-url="https://tools.example.com"'));
  assert.ok(!policy.includes("trace"));
  const enabled = JSON.parse(requests[3]!.init!.body as string).properties;
  assert.equal(enabled.subscriptionRequired, false);
});

test("MCP policy failure never unlocks API", async () => {
  const requests: RequestInit[] = [];
  const input = { id: "trusted", name: "Trusted MCP", path: "mcp/trusted",
    backendUrl: "https://tools.example.com/mcp", authAudience: "api://trusted-tools" };
  const cloud = new AzureCloud(azureConfig(), (async (url, init) => {
    requests.push(init!);
    return String(url).includes("/policies/") ? json({ error: "bad policy" }, 400)
      : json({ properties: { provisioningState: "Succeeded" } });
  }) as Fetcher, identity);
  await assert.rejects(cloud.registerMcp(input));
  assert.equal(requests.length, 3);
  assert.ok(!requests.some(r => typeof r.body === "string" && r.body.includes('"subscriptionRequired":false')));
});

test("inventory continuation cannot send ARM tokens to another host or account", async () => {
  const cloud = new AzureCloud(azureConfig(), (async () => json({
    value: [], nextLink: "https://evil.example/steal",
  })) as Fetcher, identity);
  await assert.rejects(cloud.deployments(), (error: unknown) => error instanceof GatewayError && error.code === "INVALID_ARM_RESPONSE");
});

test("inventory preserves actual billing SKU and format and fails closed on missing metadata", async () => {
  const cloud = new AzureCloud(azureConfig(), (async () => json({
    value: [
      { name: "provisioned", sku: { name: "ProvisionedManaged", capacity: 50 },
        properties: { provisioningState: "Succeeded", model: { name: "gpt-4o", version: "2024-08-06", format: "OpenAI" } } },
      { name: "unknown", properties: { provisioningState: "Succeeded", model: { name: "unrecognized" } } },
    ],
  })) as Fetcher, identity);
  const rows = await cloud.deployments();
  assert.equal(rows[0]!.sku, "ProvisionedManaged");
  assert.equal(rows[0]!.capacity, 50);
  assert.equal(rows[0]!.format, "OpenAI");
  assert.equal(rows[1]!.sku, "unknown");
  assert.equal(rows[1]!.format, "unknown");
  assert.equal(rows[1]!.capacity, 0);
});

test("external MCP resource names cannot overwrite the built-in inference API", async () => {
  const cloud = new AzureCloud(azureConfig(), (async url => {
    assert.ok(String(url).includes("/apis/external-mcp-gateway-inference"));
    return json({ properties: { provisioningState: "Succeeded" } });
  }) as Fetcher, identity);
  assert.equal(await cloud.registerMcp({ id: "gateway-inference", name: "Isolated external ID", path: "mcp/isolated",
    backendUrl: "https://tools.example.com/custom/mcp", authAudience: "api://trusted-tools" }), "Succeeded");
});

test("MCP nested backend paths occur only in the single message endpoint", async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  const cloud = new AzureCloud(azureConfig(), (async (url, init) => {
    requests.push({ url: String(url), init });
    return json({ properties: { provisioningState: "Succeeded" } });
  }) as Fetcher, identity);
  const input = { id: "nested", name: "Nested MCP", path: "mcp/nested",
    backendUrl: "https://tools.example.com/custom/mcp", authAudience: "api://trusted-tools" };
  await cloud.registerMcp(input);
  for (const index of [0, 3]) {
    const body = JSON.parse(requests[index]!.init!.body as string);
    assert.deepEqual(body, { properties: {
      displayName: "Nested MCP", path: "mcp/nested", protocols: ["https"], type: "mcp",
      serviceUrl: "https://tools.example.com", subscriptionRequired: index === 0,
      description: "External MCP tool charges are not covered by the model-cost ledger.",
      mcpProperties: { transportType: "streamable", endpoints: [{ name: "message", uriTemplate: "/custom/mcp" }] },
    } });
  }
  const policy = JSON.parse(requests[2]!.init!.body as string).properties.value as string;
  assert.ok(policy.includes('<set-backend-service base-url="https://tools.example.com"'));
  assert.ok(!policy.includes("https://tools.example.com/custom/mcp"));
});

test("reserved governance paths are rejected before any Azure request", async () => {
  const cloud = new AzureCloud(azureConfig(), (async () => {
    assert.fail("Reserved paths must not reach ARM.");
  }) as Fetcher, identity);
  for (const path of ["mcp/governance", "mcp/Governance"]) {
    await assert.rejects(cloud.registerMcp({ id: "governance", name: "Collision", path,
      backendUrl: "https://tools.example.com/mcp", authAudience: "api://trusted-tools" }));
  }
});

test("playground only calls configured APIM and returns settlement header, never obtains MI token", async () => {
  const cloud = new AzureCloud(azureConfig(), (async (url, init) => {
    assert.equal(String(url), "https://test-apim.azure-api.net/openai/v1/chat/completions");
    const headers = init!.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer user-access-token");
    assert.equal(headers["X-Team-Id"], "demo-engineering");
    return new Response(JSON.stringify(simulated(chat)), {
      headers: { "content-type": "application/json", "x-gateway-charged-micros": "123" },
    });
  }) as Fetcher, { getToken: async () => { assert.fail("Playground must not get a backend token"); } });
  const result = await cloud.playground(chat, "demo-engineering", "Bearer user-access-token");
  assert.equal(result.chargedMicros, 123);
});
