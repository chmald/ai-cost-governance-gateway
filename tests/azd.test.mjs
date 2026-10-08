import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AzureIo, SetupError, waitFor } from '../scripts/azd/common.mjs';
import { assignRole, completeIdentity, setupRegistrations } from '../scripts/azd/identity.mjs';
import { checkTarget, guardDown, immutableImage, migrateRelease, parsePublishedImage, prepare, validateMcpAllowlists, validateScale, verifyRelease } from '../scripts/azd/workflow.mjs';

const uuid = n => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const digest = `sha256:${'a'.repeat(64)}`;
const env = () => ({
  AZURE_ENV_NAME: 'gateway-test', AZURE_SUBSCRIPTION_ID: uuid(1), AZURE_TENANT_ID: uuid(2),
  AZURE_LOCATION: 'eastus2', AZURE_RESOURCE_GROUP: 'rg-gateway-test',
  FOUNDRY_RESOURCE_GROUP: 'foundry', FOUNDRY_ACCOUNT_NAME: 'existing-foundry',
  APIM_PUBLISHER_NAME: 'Test publisher', APIM_PUBLISHER_EMAIL: 'operator@example.test',
  ENTRA_SETUP_MODE: 'auto', GATEWAY_URL: 'https://gateway.test.eastus.azurecontainerapps.io',
  AZURE_CONTAINER_APP_NAME: 'gateway',
  APIM_PRINCIPAL_ID: uuid(3), GATEWAY_ADMIN_OBJECT_ID: uuid(4),
  AZURE_CONTAINER_REGISTRY_NAME: 'gatewayregistry', AZURE_CONTAINER_REGISTRY_ENDPOINT: 'gatewayregistry.azurecr.io',
  SERVICE_GATEWAY_IMAGE_NAME: 'gatewayregistry.azurecr.io/foundry/gateway:release',
  MIGRATION_JOB_NAME: 'gateway-migrate', AZURE_CONTAINER_APPS_ENVIRONMENT_ID: `/subscriptions/${uuid(1)}/resourceGroups/rg-gateway-test/providers/Microsoft.App/managedEnvironments/gateway-env`,
  AZURE_CONTAINER_APPS_ENVIRONMENT_NAME: 'gateway-env',
  MIGRATION_IDENTITY_ID: `/subscriptions/${uuid(1)}/resourceGroups/rg-gateway-test/providers/Microsoft.ManagedIdentity/userAssignedIdentities/migrator`,
  MIGRATION_CLIENT_ID: uuid(5), MIGRATION_PRINCIPAL_NAME: 'gateway-migrator',
  RUNTIME_PRINCIPAL_ID: uuid(6), POSTGRES_HOST: 'gateway-pg.postgres.database.azure.com',
  POSTGRES_DATABASE: 'gateway', POSTGRES_APP_ROLE: 'gateway_app',
});
const response = body => ({ body, status: 200, headers: new Headers() });

class FakeIo {
  apps = [];
  principals = [];
  assignments = [];
  writes = [];
  requests = [];
  next = 20;
  jobStatus = 'Succeeded';
  executionImage = undefined;
  async delay() {}
  async token() { return 'not-a-real-token-never-persist'; }
  async command(tool, args) {
    if (tool === 'azd' && args[0] === 'version') return 'azd version 1.30.0 (stable)';
    if (tool === 'bicep' && args[0] === '--version') return 'Bicep CLI 0.44.1';
    if (tool === 'bicep' && args[0] === 'build') return JSON.stringify({ resources: [] });
    throw new Error(`Unexpected command ${tool} ${args.join(' ')}`);
  }
  async save(environment, key, value) { this.writes.push([key, value]); environment[key] = value; }
  async prompt(environment, key, _label, fallback) {
    if (!environment[key]) {
      if (!fallback) throw new SetupError('CONFIG_REQUIRED', key);
      await this.save(environment, key, fallback);
    }
    return environment[key];
  }
  async graph(environment, path, options = {}) {
    const method = options.method ?? 'GET';
    this.requests.push({ path, method, body: options.body });
    const url = new URL(`https://graph.microsoft.com/v1.0${path}`);
    const clean = url.pathname.slice('/v1.0'.length);
    if (clean === '/applications' && method === 'GET') {
      const filter = url.searchParams.get('$filter');
      const value = /'([^']+)'/.exec(filter)[1];
      const key = filter.startsWith('appId') ? 'appId' : 'displayName';
      return response({ value: this.apps.filter(app => app[key] === value).map(app => structuredClone(app)) });
    }
    if (clean === '/applications' && method === 'POST') {
      const app = { id: uuid(this.next++), appId: uuid(this.next++), appRoles: [], api: {},
        identifierUris: [], requiredResourceAccess: [], ...options.body };
      this.apps.push(app);
      return response(structuredClone(app));
    }
    if (clean.startsWith('/applications/')) {
      const app = this.apps.find(item => item.id === clean.split('/')[2]);
      assert.ok(app, 'Known application');
      if (method === 'PATCH') Object.assign(app, structuredClone(options.body));
      return response(structuredClone(app));
    }
    if (clean === '/servicePrincipals' && method === 'GET') {
      const appId = /'([^']+)'/.exec(url.searchParams.get('$filter'))[1];
      return response({ value: this.principals.filter(sp => sp.appId === appId).map(sp => structuredClone(sp)) });
    }
    if (clean === '/servicePrincipals' && method === 'POST') {
      const sp = { id: uuid(this.next++), appRoleAssignmentRequired: false, ...options.body };
      this.principals.push(sp);
      return response(structuredClone(sp));
    }
    if (clean.endsWith('/appRoleAssignedTo')) {
      const resourceId = clean.split('/')[2];
      if (method === 'GET') return response({ value: this.assignments.filter(item => item.resourceId === resourceId) });
      this.assignments.push(structuredClone(options.body));
      return response(options.body);
    }
    if (clean.startsWith('/servicePrincipals/') && method === 'PATCH') {
      Object.assign(this.principals.find(item => item.id === clean.split('/')[2]), options.body);
      return response(null);
    }
    if (clean === '/me') return response({ id: uuid(4) });
    throw new Error(`Unexpected Graph call ${method} ${clean}`);
  }
  async arm(environment, path, options = {}) {
    this.requests.push({ path, method: options.method ?? 'GET', body: options.body });
    if (path === `/subscriptions/${environment.AZURE_SUBSCRIPTION_ID}?api-version=2022-12-01`) {
      return response({ subscriptionId: environment.AZURE_SUBSCRIPTION_ID, tenantId: environment.AZURE_TENANT_ID, state: 'Enabled' });
    }
    if (path.includes('/Microsoft.CognitiveServices/accounts/')) {
      return response({ kind: 'AIServices', properties: { customSubDomainName: 'existing-foundry' } });
    }
    if (path.includes('/resourceGroups/') && !path.includes('/providers/')) {
      return response({ location: environment.AZURE_LOCATION,
        tags: { 'azd-env-name': environment.AZURE_ENV_NAME, application: 'foundry-ai-gateway' } });
    }
    if (path.includes('/Microsoft.ContainerRegistry/registries/')) return response({ properties: { loginServer: environment.AZURE_CONTAINER_REGISTRY_ENDPOINT } });
    if (path.includes('/Microsoft.Resources/deployments/')) {
      if (options.method === 'PUT') this.deployment = options.body.properties;
      return response({ properties: { provisioningState: 'Succeeded' } });
    }
    if (path.includes('/executions/')) return response({ properties: {
      status: this.jobStatus, template: { containers: [{ image: this.executionImage ?? this.started.containers[0].image }] },
    } });
    if (path.includes('/start?')) {
      this.started = options.body;
      return response({ name: 'gateway-migrate-execution' });
    }
    if (path.includes('/Microsoft.App/jobs/')) {
      const parameters = this.deployment.parameters;
      return response({
        identity: { userAssignedIdentities: { [parameters.migrationIdentityId.value]: {} } },
        properties: { template: { containers: [{ name: 'migrate', image: parameters.imageName.value,
          command: ['node', 'apps/api/dist/bootstrap.js'], env: [{ name: 'AZURE_CLIENT_ID', value: environment.MIGRATION_CLIENT_ID }] }] } },
      });
    }
    if (path.includes('/Microsoft.App/containerApps/')) return response({
      tags: { 'azd-service-name': 'gateway' },
      properties: { configuration: { ingress: { fqdn: new URL(environment.GATEWAY_URL).hostname } },
        template: { containers: [{ image: environment.GATEWAY_DEPLOY_IMAGE }] } },
    });
    throw new Error(`Unexpected ARM call ${path}`);
  }
  async request(url, options = {}) {
    this.requests.push({ path: url, method: options.method ?? 'GET', form: options.form });
    if (url.endsWith('/oauth2/exchange')) return response({ refresh_token: 'fake-acr-refresh-secret' });
    if (url.endsWith('/oauth2/token')) return response({ access_token: 'fake-acr-access-secret' });
    if (url.includes('/manifests/')) return { ...response(null), headers: new Headers({ 'docker-content-digest': digest }) };
    if (url.endsWith('/readyz')) return response({ status: 'ready', mode: 'azure' });
    if (url.endsWith('/api/config')) return response(this.applicationConfig);
    throw new Error(`Unexpected request ${url}`);
  }
}

test('owned Entra setup creates only three single-tenant registrations and is resumable', async () => {
  const io = new FakeIo(); const values = env();
  await setupRegistrations(io, values);
  assert.equal(io.apps.length, 3);
  assert.equal(io.principals.length, 2);
  assert.equal(io.assignments.length, 1);
  assert.ok(io.apps.every(app => app.signInAudience === 'AzureADMyOrg'));
  assert.ok(io.principals.every(sp => sp.appRoleAssignmentRequired));
  await setupRegistrations(io, values);
  assert.equal(io.apps.length, 3);
  assert.equal(io.assignments.length, 1);
  assert.equal(values.ENTRA_API_SCOPE, `api://${values.ENTRA_API_AUDIENCE}/access_as_user`);
  assert.ok(!JSON.stringify(io.writes).includes('token'));
});

test('owned setup exposes Gateway.Agent as an Application-only role for app-only callers', async () => {
  const io = new FakeIo(); const values = env();
  await setupRegistrations(io, values);
  const api = io.apps.find(app => app.appId === values.ENTRA_API_AUDIENCE);
  const agent = api.appRoles.filter(role => role.value === 'Gateway.Agent');
  assert.equal(agent.length, 1);
  assert.deepEqual(agent[0].allowedMemberTypes, ['Application']);
  assert.equal(values.GATEWAY_AGENT_ROLE_ID, agent[0].id);
  for (const role of api.appRoles.filter(item => item.value !== 'Gateway.Agent')) assert.deepEqual(role.allowedMemberTypes, ['User']);
  // No application is granted Gateway.Agent automatically; operators assign it per agent identity.
  assert.ok(io.assignments.every(assignment => assignment.appRoleId !== agent[0].id));
});

test('existing registrations without Gateway.Agent remain valid and are not modified', async () => {
  const io = new FakeIo(); const values = env();
  await setupRegistrations(io, values);
  await completeIdentity(io, values);
  const api = io.apps.find(app => app.appId === values.ENTRA_API_AUDIENCE);
  api.appRoles = api.appRoles.filter(role => role.value !== 'Gateway.Agent');
  delete values.GATEWAY_AGENT_ROLE_ID;
  values.ENTRA_SETUP_MODE = 'existing';
  io.requests = [];
  await setupRegistrations(io, values);
  assert.ok(io.requests.every(request => request.method === 'GET'));
  assert.equal(values.GATEWAY_AGENT_ROLE_ID, undefined);
  api.appRoles.push({ id: uuid(77), value: 'Gateway.Agent', isEnabled: true, allowedMemberTypes: ['User', 'Application'] });
  await assert.rejects(setupRegistrations(io, values), error => error.code === 'MISSING_APP_ROLE');
});
test('ownership mismatch prevents mutation of an unrelated application', async () => {
  const io = new FakeIo(); const values = env();
  await setupRegistrations(io, values);
  io.apps[0].notes = 'a different environment';
  io.requests = [];
  await assert.rejects(setupRegistrations(io, values), error => error.code === 'REGISTRATION_NOT_OWNED');
  assert.ok(io.requests.every(request => request.method === 'GET'));
});

test('existing registrations are validated, never silently modified', async () => {
  const io = new FakeIo(); const values = env();
  await setupRegistrations(io, values);
  await completeIdentity(io, values);
  values.ENTRA_SETUP_MODE = 'existing';
  io.requests = [];
  await setupRegistrations(io, values);
  await completeIdentity(io, values);
  assert.ok(io.requests.every(request => request.method === 'GET'));
  io.apps[0].spa.redirectUris = [];
  await assert.rejects(completeIdentity(io, values), error => error.code === 'REDIRECT_REQUIRED');
});

test('missing tenant privileges remain explicit and do not grant Graph roles to runtime identities', async () => {
  const io = new FakeIo(); const values = env();
  io.graph = async () => { throw new SetupError('Authorization_RequestDenied', 'Administrator action required', 403); };
  await assert.rejects(setupRegistrations(io, values), error => error.status === 403);
  assert.equal(io.assignments.length, 0);
});

test('APIM receives only its proof API application role and duplicate assignment is avoided', async () => {
  const io = new FakeIo(); const values = env();
  await setupRegistrations(io, values);
  await completeIdentity(io, values);
  await completeIdentity(io, values);
  const granted = io.assignments.filter(assignment => assignment.principalId === values.APIM_PRINCIPAL_ID);
  assert.deepEqual(granted, [{
    principalId: values.APIM_PRINCIPAL_ID, resourceId: values.GATEWAY_PROOF_SERVICE_PRINCIPAL_ID,
    appRoleId: values.GATEWAY_INVOKE_ROLE_ID,
  }]);
});

test('unsafe Graph pagination is rejected instead of forwarding credentials', async () => {
  const io = new FakeIo();
  io.graph = async () => response({ value: [], '@odata.nextLink': 'https://evil.example/assignments' });
  await assert.rejects(assignRole(io, env(), uuid(4), uuid(5), uuid(6)), error => error.code === 'INVALID_ASSIGNMENTS');
});

test('preparation derives Foundry endpoint from the selected account and refuses tenant-only context', async () => {
  const io = new FakeIo(); const values = env();
  await prepare(io, values);
  assert.equal(values.FOUNDRY_ENDPOINT, 'https://existing-foundry.services.ai.azure.com/');
  assert.equal(values.APIM_SKU, 'Developer');
  const denied = new FakeIo();
  denied.arm = async () => response({ state: 'Warned', tenantId: uuid(2), subscriptionId: uuid(1) });
  await assert.rejects(prepare(denied, env()), error => error.code === 'SUBSCRIPTION_UNAVAILABLE');
  assert.equal(denied.apps.length, 0);
});

test('provision/preview hooks are read-only and never perform first-time Entra setup', async () => {
  const io = new FakeIo(); const values = env();
  await assert.rejects(checkTarget(io, values), error => error.code === 'IDENTITY_SETUP_REQUIRED');
  assert.equal(io.apps.length, 0);
  await prepare(io, values);
  io.requests = [];
  await checkTarget(io, values);
  assert.ok(io.requests.every(request => request.method === 'GET'));
  io.assignments = [];
  await assert.rejects(checkTarget(io, values), error => error.code === 'ROLE_ASSIGNMENT_REQUIRED');
  assert.ok(io.requests.every(request => request.method === 'GET'));
});

test('remote image resolution is restricted to the provisioned registry and exact manifest digest', async () => {
  const io = new FakeIo(); const values = env();
  assert.equal(await immutableImage(io, values), `gatewayregistry.azurecr.io/foundry/gateway@${digest}`);
  for (const image of ['evil.example/x:tag', 'gatewayregistry.azurecr.io/x', 'gatewayregistry.azurecr.io/a/../b:t']) {
    assert.throws(() => parsePublishedImage({ ...values, SERVICE_GATEWAY_IMAGE_NAME: image }));
  }
  assert.ok(io.writes.every(([key]) => !/TOKEN|SECRET|PASSWORD/.test(key)));
});

test('MCP allowlists reject wildcards, private addresses and the internal proof audience', () => {
  for (const host of ['*.example.com', '127.0.0.1', 'https://tools.example.com', 'service.local']) {
    assert.throws(() => validateMcpAllowlists({ MCP_ALLOWED_HOSTS: host }), error => error.code === 'INVALID_MCP_HOSTS');
  }
  assert.throws(() => validateMcpAllowlists({
    GATEWAY_API_AUDIENCE: uuid(2), MCP_ALLOWED_AUDIENCES: `api://${uuid(2)}`,
  }), error => error.code === 'INVALID_MCP_AUDIENCES');
  assert.doesNotThrow(() => validateMcpAllowlists({ MCP_ALLOWED_HOSTS: 'tools.example.com', MCP_ALLOWED_AUDIENCES: 'api://external-tools' }));
});

test('release rejects inconsistent replica bounds before changing Azure resources', async () => {
  for (const values of [{ GATEWAY_MIN_REPLICAS: '0' }, { GATEWAY_MAX_REPLICAS: '31' },
    { GATEWAY_MIN_REPLICAS: '5', GATEWAY_MAX_REPLICAS: '3' }]) {
    assert.throws(() => validateScale(values), error => error.code === 'INVALID_SCALE');
  }
  const io = new FakeIo();
  await assert.rejects(migrateRelease(io, { ...env(), GATEWAY_MAX_REPLICAS: '0' }), error => error.code === 'INVALID_SCALE');
  assert.equal(io.requests.length, 0);
});

test('release is gated on successful migration of the exact immutable image', async () => {
  const io = new FakeIo(); const values = env();
  await setupRegistrations(io, values);
  await migrateRelease(io, values);
  assert.equal(values.GATEWAY_DEPLOY_IMAGE, `gatewayregistry.azurecr.io/foundry/gateway@${digest}`);
  assert.equal(io.started.containers[0].image, values.GATEWAY_DEPLOY_IMAGE);
  assert.equal(io.started.containers[0].env[0].value, values.MIGRATION_CLIENT_ID);
  assert.deepEqual(io.started.initContainers, []);
  assert.ok(!JSON.stringify(io.writes).includes('fake-acr'));
});

test('failed or wrong-image migrations never update the app release image', async () => {
  for (const kind of ['failed', 'wrong-image']) {
    const io = new FakeIo(); const values = env();
    await setupRegistrations(io, values);
    if (kind === 'failed') io.jobStatus = 'Failed';
    else io.executionImage = 'gatewayregistry.azurecr.io/not-the-release:other';
    await assert.rejects(migrateRelease(io, values), error => ['MIGRATION_FAILED', 'MIGRATION_IMAGE_UNVERIFIED'].includes(error.code));
    assert.equal(values.GATEWAY_DEPLOY_IMAGE, undefined);
    assert.ok(!io.requests.some(request => request.path.includes('/containerApps/')));
  }
});

test('postdeployment verifies the real image, endpoint, readiness and sign-in configuration', async () => {
  const io = new FakeIo(); const values = env();
  await setupRegistrations(io, values);
  values.GATEWAY_DEPLOY_IMAGE = `gatewayregistry.azurecr.io/foundry/gateway@${digest}`;
  io.applicationConfig = { mode: 'azure', auth: { tenantId: values.AZURE_TENANT_ID,
    clientId: values.ENTRA_SPA_CLIENT_ID, apiScope: values.ENTRA_API_SCOPE } };
  await verifyRelease(io, values);
  io.applicationConfig.mode = 'demo';
  await assert.rejects(verifyRelease(io, values), error => error.code === 'IDENTITY_CONFIGURATION_MISMATCH');
});

test('destructive down and unbounded polling cannot silently succeed', async () => {
  const io = new FakeIo();
  await assert.rejects(guardDown(io, env()), error => error.code === 'DATA_DELETION_BLOCKED');
  await guardDown(io, { ...env(), AZD_ALLOW_DATA_DELETION: 'true' });
  await assert.rejects(waitFor(io, async () => undefined, () => false, { attempts: 2, delay: 0 }), error => error.code === 'OPERATION_TIMEOUT');
});

test('CLI credentials and raw diagnostics are not exposed in hook errors or environment writes', async () => {
  const io = new AzureIo({ run: async () => { throw new Error('SUPER_SECRET_TOKEN'); } });
  await assert.rejects(io.command('azd', ['auth', 'token']), error => !error.message.includes('SUPER_SECRET_TOKEN'));
  await assert.rejects(io.save({}, 'ACCESS_TOKEN', 'secret'), error => error.code === 'UNSAFE_ENVIRONMENT_VALUE');
});

test('ARM requests cannot escape the selected subscription and redirects are disabled', async () => {
  const values = env();
  let called = false;
  const io = new AzureIo({ run: async () => ({ stdout: 'a-safe-fake-access-token-value' }),
    fetcher: async (_url, options) => { called = true; assert.equal(options.redirect, 'error'); return Response.json({ status: 'ok' }); } });
  await assert.rejects(io.arm(values, `/subscriptions/${uuid(99)}/resourceGroups/wrong?api-version=test`), error => error.code === 'TARGET_MISMATCH');
  assert.equal(called, false);
  await io.arm(values, `/subscriptions/${values.AZURE_SUBSCRIPTION_ID}?api-version=2022-12-01`);
  assert.equal(called, true);
});
