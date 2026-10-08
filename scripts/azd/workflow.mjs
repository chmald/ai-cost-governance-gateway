import { join } from 'node:path';
import { isIP } from 'node:net';
import { ARM, appApiVersion, armNamePattern, guidPattern, publicOrigin, readEventually, required, resourcePath, root, SetupError, waitFor } from './common.mjs';
import { completeIdentity, setupRegistrations } from './identity.mjs';

export async function prepare(io, env, { readOnly = false } = {}) {
  required(env, 'AZURE_ENV_NAME', /^[a-z][a-z0-9-]{1,30}$/);
  await io.prompt(env, 'AZURE_SUBSCRIPTION_ID', 'Azure subscription ID');
  await io.prompt(env, 'AZURE_LOCATION', 'Azure region (for example eastus2)');
  const subscription = required(env, 'AZURE_SUBSCRIPTION_ID', guidPattern);
  required(env, 'AZURE_LOCATION', /^[a-z][a-z0-9]{1,40}$/);
  const version = await io.command('azd', ['version']);
  if (!/azd version 1\.(?:[3-9]\d|\d{3,})\./.test(version)) {
    throw new SetupError('AZD_VERSION', 'This workflow requires azd 1.30 or newer within major version 1.');
  }
  await io.command('bicep', ['--version']);
  const { body: target } = await io.arm(env, `/subscriptions/${subscription}?api-version=2022-12-01`);
  if (!guidPattern.test(target?.tenantId ?? '') || target.state !== 'Enabled' ||
      target.subscriptionId?.toLowerCase() !== subscription.toLowerCase()) {
    throw new SetupError('SUBSCRIPTION_UNAVAILABLE', 'Select a real, enabled subscription; a tenant-level CLI context cannot deploy resources.');
  }
  if (env.AZURE_TENANT_ID && env.AZURE_TENANT_ID.toLowerCase() !== target.tenantId.toLowerCase()) {
    throw new SetupError('TENANT_MISMATCH', 'The selected subscription does not belong to AZURE_TENANT_ID.');
  }
  await io.save(env, 'AZURE_TENANT_ID', target.tenantId);
  const group = `rg-${env.AZURE_ENV_NAME}`;
  if (env.AZURE_RESOURCE_GROUP && env.AZURE_RESOURCE_GROUP !== group) {
    throw new SetupError('RESOURCE_GROUP_MISMATCH', 'This profile uses rg-<environment>. Use a separate azd environment instead of redirecting an existing deployment.');
  }
  try {
    const { body: existing } = await io.arm(env, `/subscriptions/${subscription}/resourceGroups/${group}?api-version=2022-09-01`);
    if (existing?.tags?.['azd-env-name'] !== env.AZURE_ENV_NAME ||
        existing.tags.application !== 'foundry-ai-gateway' || existing.location !== env.AZURE_LOCATION) {
      throw new SetupError('RESOURCE_GROUP_NOT_OWNED', 'The target resource group already exists but is not owned by this environment at this location. Select a different environment name.');
    }
  } catch (error) {
    if (!(error instanceof SetupError) || error.status !== 404) throw error;
  }
  await io.prompt(env, 'FOUNDRY_RESOURCE_GROUP', 'Existing Foundry resource group');
  await io.prompt(env, 'FOUNDRY_ACCOUNT_NAME', 'Existing Foundry account name');
  await io.prompt(env, 'APIM_PUBLISHER_NAME', 'APIM publisher name', 'AI Gateway Team');
  await io.prompt(env, 'APIM_PUBLISHER_EMAIL', 'APIM publisher email');
  required(env, 'APIM_PUBLISHER_EMAIL', /^[^\s@]+@[^\s@]+\.[^\s@]+$/);
  const foundryGroup = required(env, 'FOUNDRY_RESOURCE_GROUP', armNamePattern);
  const account = required(env, 'FOUNDRY_ACCOUNT_NAME', /^[a-zA-Z0-9][a-zA-Z0-9-]{1,63}$/);
  const { body: foundry } = await io.arm(env,
    `/subscriptions/${subscription}/resourceGroups/${encodeURIComponent(foundryGroup)}/providers/Microsoft.CognitiveServices/accounts/${account}?api-version=2025-06-01`);
  const domain = foundry?.properties?.customSubDomainName;
  if (!['OpenAI', 'AIServices'].includes(foundry?.kind) || !/^[a-z0-9][a-z0-9-]{1,63}$/i.test(domain ?? '')) {
    throw new SetupError('FOUNDRY_UNSUPPORTED', 'The existing account must be OpenAI or AIServices with a configured custom subdomain.');
  }
  if ((foundry.properties.publicNetworkAccess === 'Disabled' || foundry.properties.networkAcls?.defaultAction === 'Deny') &&
      env.FOUNDRY_NETWORK_REVIEWED !== 'true') {
    throw new SetupError('FOUNDRY_NETWORK_RESTRICTED', 'Foundry restricts network access. Review/customize routing, DNS or approved egress from the new ACA network before setting FOUNDRY_NETWORK_REVIEWED=true. Setup will not open the existing account firewall.');
  }
  const endpoint = `https://${domain}.${foundry.kind === 'OpenAI' ? 'openai' : 'services.ai'}.azure.com`;
  if (env.FOUNDRY_ENDPOINT && publicOrigin(env.FOUNDRY_ENDPOINT, '.azure.com').toLowerCase() !== endpoint.toLowerCase()) {
    throw new SetupError('FOUNDRY_ENDPOINT_MISMATCH', 'FOUNDRY_ENDPOINT does not match the selected account and its verified custom subdomain.');
  }
  await io.save(env, 'FOUNDRY_ENDPOINT', `${endpoint}/`);
  if (!env.APIM_SKU) await io.save(env, 'APIM_SKU', 'Developer');
  if (!['Developer', 'BasicV2', 'StandardV2', 'PremiumV2'].includes(env.APIM_SKU)) {
    throw new SetupError('INVALID_SKU', 'Select an APIM Developer or supported v2 SKU.');
  }
  if (!env.ENTRA_SETUP_MODE) await io.save(env, 'ENTRA_SETUP_MODE', 'auto');
  if (!['auto', 'existing'].includes(env.ENTRA_SETUP_MODE)) throw new SetupError('INVALID_IDENTITY_MODE', 'ENTRA_SETUP_MODE must be auto or existing.');
  console.info(`${readOnly ? 'Checking' : 'Preparing'} ${env.AZURE_ENV_NAME} in ${env.AZURE_LOCATION}; APIM ${env.APIM_SKU}. Developer/Burstable defaults are for evaluation, not production availability.`);
  if (readOnly && ['ENTRA_SPA_CLIENT_ID', 'ENTRA_API_AUDIENCE', 'GATEWAY_API_AUDIENCE'].some(key => !env[key])) {
    throw new SetupError('IDENTITY_SETUP_REQUIRED', 'Run azd up for first-time setup, or explicitly approve/run azd hooks run preup before a provision preview. Provision hooks never create or change Entra registrations.');
  }
  await setupRegistrations(io, env, { readOnly });
  validateMcpAllowlists(env);
  validateScale(env);
}

export async function checkTarget(io, env) {
  return prepare(io, env, { readOnly: true });
}

export function validateScale(env) {
  const minimum = env.GATEWAY_MIN_REPLICAS ?? '1';
  const maximum = env.GATEWAY_MAX_REPLICAS ?? '3';
  if (!/^(?:[1-9]|10)$/.test(minimum) || !/^(?:[1-9]|[12]\d|30)$/.test(maximum) || Number(maximum) < Number(minimum)) {
    throw new SetupError('INVALID_SCALE', 'Set minimum replicas from 1-10 and maximum from 1-30, with maximum at least minimum.');
  }
}

export function validateMcpAllowlists(env) {
  const hosts = (env.MCP_ALLOWED_HOSTS ?? '').split(',').map(value => value.trim()).filter(Boolean);
  if (hosts.some(host => isIP(host) || !/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(host) ||
      host.toLowerCase().endsWith('.local') || host.includes('..'))) {
    throw new SetupError('INVALID_MCP_HOSTS', 'MCP_ALLOWED_HOSTS must contain exact public DNS names, not IPs, URLs or wildcards.');
  }
  const audiences = (env.MCP_ALLOWED_AUDIENCES ?? '').split(',').map(value => value.trim()).filter(Boolean);
  const internal = (env.GATEWAY_API_AUDIENCE ?? '').toLowerCase();
  if (audiences.some(audience => [internal, `api://${internal}`].includes(audience.toLowerCase()) ||
      /[\s*<>"']/.test(audience))) {
    throw new SetupError('INVALID_MCP_AUDIENCES', 'External MCP audiences must be explicit and must not include the internal gateway-proof API.');
  }
}

export function parsePublishedImage(env) {
  const registry = publicOrigin(`https://${required(env, 'AZURE_CONTAINER_REGISTRY_ENDPOINT')}`, '.azurecr.io').slice(8);
  const image = required(env, 'SERVICE_GATEWAY_IMAGE_NAME');
  if (!image.startsWith(`${registry}/`)) throw new SetupError('UNAPPROVED_IMAGE', 'The release image must come from this environment\'s ACR.');
  const relative = image.slice(registry.length + 1);
  const match = /^([a-z0-9][a-z0-9._/-]*)(?::([a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127})|@(sha256:[0-9a-f]{64}))$/.exec(relative);
  if (!match || match[1].split('/').some(part => !part || part === '.' || part === '..')) {
    throw new SetupError('INVALID_IMAGE', 'The published image must contain an explicit valid repository and tag or SHA-256 digest.');
  }
  return { registry, repository: match[1], reference: match[2] ?? match[3] };
}

export async function immutableImage(io, env) {
  const parsed = parsePublishedImage(env);
  const registryPath = resourcePath(env, 'Microsoft.ContainerRegistry', 'registries', required(env, 'AZURE_CONTAINER_REGISTRY_NAME', armNamePattern));
  const { body: registry } = await io.arm(env, `${registryPath}?api-version=2023-07-01`);
  if (registry?.properties?.loginServer !== parsed.registry) throw new SetupError('REGISTRY_MISMATCH', 'Published image registry does not match the provisioned ACR.');
  const exchange = await io.request(`https://${parsed.registry}/oauth2/exchange`, { method: 'POST', form: {
    grant_type: 'access_token', service: parsed.registry,
    tenant: required(env, 'AZURE_TENANT_ID', guidPattern),
    access_token: await io.token(env, `${ARM}/.default`),
  } });
  if (typeof exchange.body?.refresh_token !== 'string') throw new SetupError('ACR_AUTH_FAILED', 'ACR did not return a refresh credential.');
  const authorization = await io.request(`https://${parsed.registry}/oauth2/token`, { method: 'POST', form: {
    grant_type: 'refresh_token', service: parsed.registry,
    scope: `repository:${parsed.repository}:pull`, refresh_token: exchange.body.refresh_token,
  } });
  if (typeof authorization.body?.access_token !== 'string') throw new SetupError('ACR_AUTH_FAILED', 'ACR did not return a repository credential.');
  const manifest = await io.request(`https://${parsed.registry}/v2/${parsed.repository}/manifests/${parsed.reference}`, {
    method: 'HEAD', headers: {
      Authorization: `Bearer ${authorization.body.access_token}`,
      Accept: 'application/vnd.oci.image.manifest.v1+json,application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.v2+json,application/vnd.docker.distribution.manifest.list.v2+json',
    },
  });
  const digest = manifest.headers.get('docker-content-digest');
  if (!/^sha256:[0-9a-f]{64}$/.test(digest ?? '') ||
      (parsed.reference.startsWith('sha256:') && parsed.reference !== digest)) {
    throw new SetupError('DIGEST_UNVERIFIED', 'ACR did not confirm the requested immutable image digest.');
  }
  return `${parsed.registry}/${parsed.repository}@${digest}`;
}

function migrationParameters(env, image) {
  return {
    environmentName: required(env, 'AZURE_ENV_NAME'),
    jobName: required(env, 'MIGRATION_JOB_NAME', armNamePattern),
    location: required(env, 'AZURE_LOCATION', /^[a-z][a-z0-9]{1,40}$/),
    containerAppsEnvironmentName: required(env, 'AZURE_CONTAINER_APPS_ENVIRONMENT_NAME', armNamePattern),
    containerRegistryName: required(env, 'AZURE_CONTAINER_REGISTRY_NAME', armNamePattern),
    migrationIdentityId: required(env, 'MIGRATION_IDENTITY_ID'),
    migrationClientId: required(env, 'MIGRATION_CLIENT_ID', guidPattern),
    imageName: image,
    postgresHost: required(env, 'POSTGRES_HOST', /^[a-z0-9-]+\.postgres\.database\.azure\.com$/),
    postgresDatabase: required(env, 'POSTGRES_DATABASE', /^[a-z][a-z0-9_]{0,62}$/),
    postgresAppRole: required(env, 'POSTGRES_APP_ROLE', /^[a-z][a-z0-9_]{0,62}$/),
    migrationPrincipalName: required(env, 'MIGRATION_PRINCIPAL_NAME', armNamePattern),
    runtimePrincipalId: required(env, 'RUNTIME_PRINCIPAL_ID', guidPattern),
  };
}

export async function migrateRelease(io, env) {
  validateMcpAllowlists(env);
  validateScale(env);
  // Recheck identity wiring on every release, including direct azd deploy.
  await completeIdentity(io, env);
  const image = await immutableImage(io, env);
  const values = migrationParameters(env, image);
  const template = JSON.parse(await io.command('bicep', ['build', join(root, 'infra', 'azd', 'migration-job.bicep'), '--stdout']));
  const deploymentPath = resourcePath(env, 'Microsoft.Resources', 'deployments', `gateway-migration-${image.slice(-12)}`);
  await io.arm(env, `${deploymentPath}?api-version=2022-09-01`, { method: 'PUT', body: {
    properties: { mode: 'Incremental', template,
      parameters: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value }])) },
  } });
  await waitFor(io, () => io.arm(env, `${deploymentPath}?api-version=2022-09-01`), result => {
    const state = result.body?.properties?.provisioningState;
    if (['Failed', 'Canceled'].includes(state)) throw new SetupError('MIGRATION_DEPLOYMENT_FAILED', 'Migration job provisioning failed; application release is blocked.');
    return state === 'Succeeded';
  }, { label: 'Migration job provisioning' });
  const jobPath = resourcePath(env, 'Microsoft.App', 'jobs', values.jobName);
  const { body: job } = await io.arm(env, `${jobPath}?api-version=${appApiVersion}`);
  const containers = job?.properties?.template?.containers;
  if (!Array.isArray(containers) || containers.length !== 1 ||
      containers[0].image !== image || !job.identity?.userAssignedIdentities?.[values.migrationIdentityId]) {
    throw new SetupError('MIGRATION_JOB_MISMATCH', 'Migration job image or identity changed before execution; application release is blocked.');
  }
  // An explicit execution template prevents a simultaneous deployment from
  // substituting another image between the job update and its start.
  const started = await io.arm(env, `${jobPath}/start?api-version=${appApiVersion}`, {
    method: 'POST', body: { containers, initContainers: [] },
  });
  let execution = started.body;
  if (!execution?.name && started.status === 202) {
    const location = started.headers.get('location');
    if (!location) throw new SetupError('MIGRATION_OUTCOME_UNCERTAIN', 'Job start returned no execution or polling location. Inspect job executions before retrying.');
    const next = new URL(location);
    const prefix = `/subscriptions/${env.AZURE_SUBSCRIPTION_ID}/`;
    if (next.origin !== ARM || !next.pathname.toLowerCase().startsWith(prefix.toLowerCase())) {
      throw new SetupError('INVALID_POLL_LOCATION', 'Job-start polling URL escaped the approved subscription.');
    }
    const result = await waitFor(io, () => io.arm(env, next.pathname + next.search),
      result => typeof result.body?.name === 'string', { label: 'Migration job start' });
    execution = result.body;
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(execution?.name ?? '')) {
    throw new SetupError('MIGRATION_OUTCOME_UNCERTAIN', 'Job start did not return a valid execution ID; application release is blocked.');
  }
  const executionPath = `${jobPath}/executions/${execution.name}?api-version=${appApiVersion}`;
  await waitFor(io, () => readEventually(io, () => io.arm(env, executionPath)), result => {
    const state = result.body?.properties?.status;
    if (['Failed', 'Stopped', 'Canceled'].includes(state)) {
      throw new SetupError('MIGRATION_FAILED', `Migration execution ${execution.name} failed. Inspect that job's metadata-only logs; no app release was performed.`);
    }
    if (state !== 'Succeeded') return false;
    const executed = result.body?.properties?.template?.containers;
    if (!Array.isArray(executed) || executed.length !== 1 || executed[0].image !== image) {
      throw new SetupError('MIGRATION_IMAGE_UNVERIFIED', 'The successful execution did not attest the intended image; application release remains blocked.');
    }
    return true;
  }, { label: 'Database bootstrap/migration' });
  await io.save(env, 'GATEWAY_DEPLOY_IMAGE', image);
  await io.save(env, 'GATEWAY_MIGRATION_EXECUTION', execution.name);
  console.info('Database bootstrap/migration succeeded for the immutable release image. Native azd application deployment may proceed.');
}

export async function verifyRelease(io, env) {
  const appPath = resourcePath(env, 'Microsoft.App', 'containerApps', required(env, 'AZURE_CONTAINER_APP_NAME', armNamePattern));
  const { body: app } = await io.arm(env, `${appPath}?api-version=${appApiVersion}`);
  const origin = publicOrigin(required(env, 'GATEWAY_URL'), '.azurecontainerapps.io');
  const image = required(env, 'GATEWAY_DEPLOY_IMAGE');
  if (`https://${app?.properties?.configuration?.ingress?.fqdn}` !== origin ||
      app?.properties?.template?.containers?.[0]?.image !== image ||
      app?.tags?.['azd-service-name'] !== 'gateway') {
    throw new SetupError('RELEASE_MISMATCH', 'The deployed application endpoint, image or service identity does not match this release.');
  }
  await waitFor(io, async () => {
    try { return await io.request(`${origin}/readyz`); } catch (error) {
      if (error instanceof SetupError && [502, 503, 504].includes(error.status)) return undefined;
      throw error;
    }
  }, result => result?.body?.status === 'ready' && result.body.mode === 'azure',
  { attempts: 60, delay: 5_000, label: 'Application database/schema readiness' });
  const config = (await io.request(`${origin}/api/config`)).body;
  if (config?.mode !== 'azure' || config.auth?.tenantId !== env.AZURE_TENANT_ID ||
      config.auth?.clientId !== env.ENTRA_SPA_CLIENT_ID || config.auth?.apiScope !== env.ENTRA_API_SCOPE) {
    throw new SetupError('IDENTITY_CONFIGURATION_MISMATCH', 'The application is not exposing the expected production sign-in configuration.');
  }
  console.info(`Application ready: ${origin}`);
  console.info('Sign in and perform the documented live APIM/MCP and priced-model acceptance checks before enabling consumers.');
}

export async function guardDown(io, env) {
  if (env.AZD_ALLOW_DATA_DELETION !== 'true') {
    throw new SetupError('DATA_DELETION_BLOCKED',
      'azd down would delete the PostgreSQL budget ledger and supporting resources. Back up and reconcile the ledger first, then explicitly set AZD_ALLOW_DATA_DELETION=true for this environment. Entra registrations are retained and must be reviewed separately.');
  }
  console.info('Explicit data-deletion acknowledgement found. Entra registrations are not automatically removed.');
}
