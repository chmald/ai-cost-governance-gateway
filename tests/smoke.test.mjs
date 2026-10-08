import assert from 'node:assert/strict';
import test from 'node:test';

const base = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:3001';

async function request(path, options = {}) {
  const response = await fetch(new URL(path, base), {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json();
  return { response, payload };
}

test('local demo exposes the portal contract and durable budget behavior', async () => {
  const config = await request('/api/config');
  assert.equal(config.response.status, 200);
  assert.equal(config.payload.mode, 'demo', 'Smoke test must never mutate an Azure environment');
  assert.equal(new URL(base).hostname, '127.0.0.1', 'Only loopback demo is supported');

  const session = await request('/api/session');
  assert.equal(session.response.status, 200);
  assert.equal(typeof session.payload.user.id, 'string');
  assert.ok(session.payload.user.roles.includes('Gateway.Admin'));

  for (const path of ['/api/teams', '/api/models', '/api/mcp-servers', '/api/usage', '/api/audit']) {
    const result = await request(path);
    assert.equal(result.response.status, 200, path);
    assert.ok(Array.isArray(result.payload.items), path);
  }

  const models = (await request('/api/models')).payload.items;
  const model = models.find((item) => item.enabled && ['ready', 'demo', 'Succeeded'].includes(item.status));
  assert.ok(model, 'Demo must include a ready, enabled, priced model');
  const id = `smoke-${Date.now()}`;
  const create = await request('/api/teams', {
    method: 'POST',
    body: JSON.stringify({
      id,
      name: 'Automated local smoke team',
      monthlyBudgetMicros: 100_000_000,
      allowedModels: [model.id],
      principals: [session.payload.user.id],
    }),
  });
  assert.ok([200, 201].includes(create.response.status), JSON.stringify(create.payload));

  const chatBody = {
    teamId: id,
    modelId: model.id,
    messages: [{ role: 'user', content: 'Reply with a short demo greeting.' }],
    maxCompletionTokens: 32,
  };
  const chat = await request('/api/playground/chat', {
    method: 'POST',
    body: JSON.stringify(chatBody),
  });
  assert.equal(chat.response.status, 200, JSON.stringify(chat.payload));
  assert.equal(typeof chat.payload.content, 'string');
  assert.ok(chat.payload.usage.chargedMicros > 0);

  const teams = (await request('/api/teams')).payload.items;
  const team = teams.find((item) => item.id === id);
  assert.equal(team.spentMicros, chat.payload.usage.chargedMicros);
  assert.equal(team.reservedMicros, 0);

  const usage = (await request('/api/usage')).payload.items.find((item) => item.teamId === id);
  assert.ok(usage, 'A completed call must have a durable usage record');
  assert.equal(usage.status, 'settled');
  assert.equal(usage.chargedMicros, team.spentMicros);

  const lowerBudget = await request(`/api/teams/${id}`, {
    method: 'PUT',
    body: JSON.stringify({
      name: team.name,
      monthlyBudgetMicros: team.spentMicros,
      allowedModels: team.allowedModels,
      principals: team.principals,
    }),
  });
  assert.equal(lowerBudget.response.status, 200, JSON.stringify(lowerBudget.payload));

  const rejected = await request('/api/playground/chat', {
    method: 'POST',
    body: JSON.stringify(chatBody),
  });
  assert.ok([402, 403, 429].includes(rejected.response.status), JSON.stringify(rejected.payload));
  assert.equal(typeof rejected.payload.error.code, 'string');

  const afterReject = (await request('/api/teams')).payload.items.find((item) => item.id === id);
  assert.equal(afterReject.spentMicros, team.spentMicros);
  assert.equal(afterReject.reservedMicros, 0);

  const unsupported = await request('/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'X-Team-Id': id },
    body: JSON.stringify({
      model: model.id,
      messages: [{ role: 'user', content: 'Do not process this.' }],
      max_completion_tokens: 32,
      stream: true,
    }),
  });
  assert.ok([400, 422].includes(unsupported.response.status), JSON.stringify(unsupported.payload));

  // App-only (agent / managed identity) caller, simulated offline with the fake demo agent identity.
  const agent = session.payload.demoAgent;
  assert.ok(agent && typeof agent.id === 'string' && typeof agent.clientAppId === 'string', 'Demo must expose its fake agent identity');
  const agentTeam = `smoke-agent-${Date.now()}`;
  const agentCreate = await request('/api/teams', {
    method: 'POST',
    body: JSON.stringify({
      id: agentTeam,
      name: 'Automated local smoke agent team',
      monthlyBudgetMicros: 100_000_000,
      allowedModels: [model.id],
      principals: [],
      applications: [agent.id],
    }),
  });
  assert.equal(agentCreate.response.status, 201, JSON.stringify(agentCreate.payload));
  assert.deepEqual(agentCreate.payload.applications, [agent.id]);
  const agentChat = (team) => request('/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'X-Team-Id': team, 'X-Demo-Caller': 'app' },
    body: JSON.stringify({ model: model.id, messages: [{ role: 'user', content: 'Agent smoke request.' }], max_completion_tokens: 32 }),
  });
  const agentResult = await agentChat(agentTeam);
  assert.equal(agentResult.response.status, 200, JSON.stringify(agentResult.payload));
  assert.equal(agentResult.payload.object, 'chat.completion');
  const agentUsage = (await request('/api/usage')).payload.items.find((item) => item.teamId === agentTeam);
  assert.ok(agentUsage, 'App-only call must have a durable usage record');
  assert.deepEqual([agentUsage.status, agentUsage.actorType, agentUsage.actorId, agentUsage.clientAppId],
    ['settled', 'app', agent.id, agent.clientAppId]);
  const agentBudget = (await request('/api/teams')).payload.items.find((item) => item.id === agentTeam);
  assert.equal(agentBudget.spentMicros, agentUsage.chargedMicros);
  // The same agent is refused on a team where it is not a registered application identity.
  const unmapped = await agentChat(id);
  assert.equal(unmapped.response.status, 403, JSON.stringify(unmapped.payload));
  assert.equal(unmapped.payload.error.code, 'TEAM_ACCESS_DENIED');
  const audit = (await request('/api/audit')).payload.items.find((item) => item.target === agentUsage.id && item.action === 'inference.settle');
  assert.equal(audit.actorType, 'app');

  const page = await fetch(base, { signal: AbortSignal.timeout(10_000) });
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(await page.text(), /<div id="root"><\/div>/);
});
