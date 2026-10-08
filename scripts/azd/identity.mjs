import { guidPattern, readEventually, required, SetupError } from './common.mjs';

const definitions = [
  { value: 'Gateway.Reader', id: 'b4c4540f-63a6-4800-a759-38c5e08c2a11', member: 'User' },
  { value: 'Gateway.User', id: '65bcf0bb-bc69-4cad-ab3b-d380885b8336', member: 'User' },
  { value: 'Gateway.Admin', id: 'a01df884-53e9-4d7d-a83d-926aace629ce', member: 'User' },
];
const proof = { value: 'Gateway.Invoke', id: 'd106df40-fb40-46d6-8288-4b5d3dfd973a', member: 'Application' };
// Application permission for app-only callers (managed identities, service principals, agent identities).
const agentRole = { value: 'Gateway.Agent', id: '473d9b1d-9d25-4def-bad7-7242e0e7774e', member: 'Application' };
const scopeId = '8514a2e4-15e5-4cba-b396-3074c6021d0a';
const select = 'id,appId,displayName,notes,signInAudience,appRoles,api,spa,identifierUris,requiredResourceAccess';
const role = definition => ({
  id: definition.id, value: definition.value, displayName: definition.value,
  description: `AI Gateway ${definition.value} access`, isEnabled: true, allowedMemberTypes: [definition.member],
});

function appShape(app) {
  if (!guidPattern.test(app?.id ?? '') || !guidPattern.test(app?.appId ?? '')) {
    throw new SetupError('INVALID_REGISTRATION', 'Microsoft Graph returned an incomplete application registration.');
  }
  return app;
}

async function findApplication(io, env, filter) {
  const { body } = await io.graph(env, `/applications?$filter=${encodeURIComponent(filter)}&$select=${select}&$top=2`);
  if (!Array.isArray(body?.value) || body.value.length > 1 || body['@odata.nextLink']) {
    throw new SetupError('AMBIGUOUS_REGISTRATION', 'Application lookup was ambiguous. Select explicit registration IDs; no existing app was repurposed.');
  }
  return body.value.length ? appShape(body.value[0]) : undefined;
}

async function application(io, env, kind, envKey, readOnly) {
  const marker = `azd:foundry-ai-gateway:${env.AZURE_SUBSCRIPTION_ID}:${env.AZURE_ENV_NAME}:${kind}`;
  const displayName = `gateway-${env.AZURE_ENV_NAME}-${kind}`;
  const existingMode = env.ENTRA_SETUP_MODE === 'existing';
  if (existingMode || readOnly) required(env, envKey, guidPattern);
  let app = env[envKey]
    ? await findApplication(io, env, `appId eq '${required(env, envKey, guidPattern)}'`)
    : await findApplication(io, env, `displayName eq '${displayName}'`);
  if (app && !existingMode && app.notes !== marker) {
    throw new SetupError('REGISTRATION_NOT_OWNED', `${envKey} refers to an application not owned by this azd environment. Use ENTRA_SETUP_MODE=existing to validate it without modifying it.`);
  }
  if (!app) {
    if (existingMode || readOnly || env[envKey]) throw new SetupError('REGISTRATION_NOT_FOUND', `The selected ${envKey} application was not found in this tenant.`);
    app = appShape((await io.graph(env, '/applications', { method: 'POST', body: {
      displayName, notes: marker, signInAudience: 'AzureADMyOrg',
    } })).body);
  }
  await io.save(env, envKey, app.appId);
  return app;
}

async function principal(io, env, app, requiredAssignment, readOnly) {
  const result = await io.graph(env, `/servicePrincipals?$filter=${encodeURIComponent(`appId eq '${app.appId}'`)}&$top=2`);
  if (!Array.isArray(result.body?.value) || result.body.value.length > 1 || result.body['@odata.nextLink']) {
    throw new SetupError('AMBIGUOUS_PRINCIPAL', 'Application service-principal lookup was ambiguous.');
  }
  let sp = result.body.value[0];
  if (!sp) {
    if (env.ENTRA_SETUP_MODE === 'existing' || readOnly) throw new SetupError('PRINCIPAL_REQUIRED', 'An administrator must create the enterprise application for each supplied API registration.');
    sp = (await io.graph(env, '/servicePrincipals', { method: 'POST', body: { appId: app.appId } })).body;
  }
  if (!guidPattern.test(sp?.id ?? '')) throw new SetupError('INVALID_PRINCIPAL', 'Invalid application service principal.');
  if (requiredAssignment && !sp.appRoleAssignmentRequired) {
    if (env.ENTRA_SETUP_MODE === 'existing' || readOnly) throw new SetupError('ASSIGNMENT_REQUIRED', 'Require user/application assignment on both API enterprise applications before deployment.');
    await io.graph(env, `/servicePrincipals/${sp.id}`, { method: 'PATCH', body: { appRoleAssignmentRequired: true } });
  }
  return sp;
}

function mergeRoles(existing = [], wanted) {
  return [...existing.filter(item => !wanted.some(definition => definition.value === item.value)),
    ...wanted.map(definition => role({ ...definition, id: existing.find(item => item.value === definition.value)?.id ?? definition.id }))];
}

function assertApi(app, expected) {
  if (app.signInAudience !== 'AzureADMyOrg' || app.api?.requestedAccessTokenVersion !== 2) {
    throw new SetupError('INVALID_API_REGISTRATION', 'Both API registrations must be single-tenant and request v2 access tokens.');
  }
  for (const definition of expected) {
    const found = app.appRoles?.find(item => item.value === definition.value);
    if (!found?.isEnabled || !guidPattern.test(found.id) ||
        found.allowedMemberTypes?.length !== 1 || found.allowedMemberTypes[0] !== definition.member) {
      throw new SetupError('MISSING_APP_ROLE', `The API requires enabled ${definition.value} for ${definition.member} principals only.`);
    }
  }
}

function accessScope(app) {
  const scope = app.api?.oauth2PermissionScopes?.find(item => item.value === 'access_as_user' && item.isEnabled);
  if (!scope || !guidPattern.test(scope.id)) throw new SetupError('MISSING_API_SCOPE', 'The user API must expose the enabled access_as_user delegated scope.');
  return scope;
}

export async function assignRole(io, env, principalId, resourceId, appRoleId, { allowWrite = true } = {}) {
  [principalId, resourceId, appRoleId].forEach(value => {
    if (!guidPattern.test(value ?? '')) throw new SetupError('INVALID_ASSIGNMENT', 'Invalid app-role assignment identity.');
  });
  let path = `/servicePrincipals/${resourceId}/appRoleAssignedTo?$filter=${encodeURIComponent(`principalId eq ${principalId}`)}`;
  // Use a principal-filtered query and handle bounded pagination rather than
  // treating a truncated Graph result as proof that an assignment is missing.
  for (let page = 0; page < 10; page++) {
    const { body } = await readEventually(io, () => io.graph(env, path));
    if (!Array.isArray(body?.value)) throw new SetupError('INVALID_ASSIGNMENTS', 'Graph returned an invalid role-assignment list.');
    if (body.value.some(item => item.principalId === principalId && item.resourceId === resourceId && item.appRoleId === appRoleId)) return;
    if (!body['@odata.nextLink']) break;
    const next = new URL(body['@odata.nextLink']);
    if (next.origin !== 'https://graph.microsoft.com' ||
        next.pathname !== `/v1.0/servicePrincipals/${resourceId}/appRoleAssignedTo` || page === 9) {
      throw new SetupError('INVALID_ASSIGNMENTS', 'Unexpected or excessive role-assignment continuation.');
    }
    path = next.pathname.slice('/v1.0'.length) + next.search;
  }
  if (!allowWrite) {
    throw new SetupError('ROLE_ASSIGNMENT_REQUIRED', `An administrator must assign the required app role to principal ${principalId} on enterprise application ${resourceId}.`);
  }
  await io.graph(env, `/servicePrincipals/${resourceId}/appRoleAssignedTo`, {
    method: 'POST', body: { principalId, resourceId, appRoleId },
  });
}

export async function setupRegistrations(io, env, { readOnly = false } = {}) {
  const existing = env.ENTRA_SETUP_MODE === 'existing';
  const spa = await application(io, env, 'spa', 'ENTRA_SPA_CLIENT_ID', readOnly);
  let api = await application(io, env, 'api', 'ENTRA_API_AUDIENCE', readOnly);
  let internal = await application(io, env, 'proof', 'GATEWAY_API_AUDIENCE', readOnly);
  if (new Set([spa.appId, api.appId, internal.appId]).size !== 3) {
    throw new SetupError('REGISTRATION_SEPARATION', 'SPA, user API and gateway-proof API must be three distinct applications.');
  }
  if (!existing && !readOnly) {
    const currentScope = api.api?.oauth2PermissionScopes?.find(item => item.value === 'access_as_user');
    const permission = {
      id: currentScope?.id ?? scopeId, value: 'access_as_user', isEnabled: true, type: 'User',
      adminConsentDisplayName: 'Use AI Gateway', adminConsentDescription: 'Access AI Gateway as the signed-in user.',
      userConsentDisplayName: 'Use AI Gateway', userConsentDescription: 'Access AI Gateway as you.',
    };
    const apiPatch = {
      identifierUris: [...new Set([...(api.identifierUris ?? []), `api://${api.appId}`])],
      appRoles: mergeRoles(api.appRoles, [...definitions, agentRole]),
      api: {
        ...api.api, requestedAccessTokenVersion: 2,
        oauth2PermissionScopes: [...(api.api?.oauth2PermissionScopes ?? []).filter(item => item.value !== permission.value), permission],
        preAuthorizedApplications: [
          ...(api.api?.preAuthorizedApplications ?? []).filter(item => item.appId !== spa.appId),
          { appId: spa.appId, delegatedPermissionIds: [permission.id] },
        ],
      },
    };
    await io.graph(env, `/applications/${api.id}`, { method: 'PATCH', body: apiPatch });
    api = { ...api, ...apiPatch };
    const internalPatch = {
      identifierUris: [...new Set([...(internal.identifierUris ?? []), `api://${internal.appId}`])],
      appRoles: mergeRoles(internal.appRoles, [proof]), api: { ...internal.api, requestedAccessTokenVersion: 2 },
    };
    await io.graph(env, `/applications/${internal.id}`, { method: 'PATCH', body: internalPatch });
    internal = { ...internal, ...internalPatch };
    const access = [
      ...(spa.requiredResourceAccess ?? []).filter(item => item.resourceAppId !== api.appId),
      { resourceAppId: api.appId, resourceAccess: [{ id: permission.id, type: 'Scope' }] },
    ];
    await io.graph(env, `/applications/${spa.id}`, { method: 'PATCH', body: { requiredResourceAccess: access } });
  }
  if (spa.signInAudience !== 'AzureADMyOrg') throw new SetupError('INVALID_SPA_REGISTRATION', 'The SPA must be single-tenant.');
  assertApi(api, definitions);
  assertApi(internal, [proof]);
  // Gateway.Agent is optional for externally managed registrations: without it, app-only callers stay disabled.
  if (api.appRoles?.some(item => item.value === agentRole.value)) {
    assertApi(api, [agentRole]);
    await io.save(env, 'GATEWAY_AGENT_ROLE_ID', api.appRoles.find(item => item.value === agentRole.value).id);
  } else {
    console.info('The user API has no Gateway.Agent application role; app-only (agent/managed identity) callers are disabled until an administrator adds it.');
  }
  const scope = accessScope(api);
  if (!api.identifierUris?.includes(`api://${api.appId}`)) throw new SetupError('MISSING_API_URI', 'The API must expose its api://<application-id> identifier URI.');
  await io.save(env, 'ENTRA_API_SCOPE', `api://${api.appId}/${scope.value}`);
  const apiSp = await principal(io, env, api, true, readOnly);
  const internalSp = await principal(io, env, internal, true, readOnly);
  await io.save(env, 'ENTRA_API_SERVICE_PRINCIPAL_ID', apiSp.id);
  await io.save(env, 'GATEWAY_PROOF_SERVICE_PRINCIPAL_ID', internalSp.id);
  await io.save(env, 'ENTRA_SPA_OBJECT_ID', spa.id);
  await io.save(env, 'GATEWAY_INVOKE_ROLE_ID', internal.appRoles.find(item => item.value === 'Gateway.Invoke').id);
  if (!env.GATEWAY_ADMIN_OBJECT_ID) {
    const { body } = await io.graph(env, '/me?$select=id');
    if (!guidPattern.test(body?.id ?? '')) throw new SetupError('ADMIN_REQUIRED', 'Set GATEWAY_ADMIN_OBJECT_ID to the bootstrap Entra user for noninteractive/service-principal deployments.');
    await io.save(env, 'GATEWAY_ADMIN_OBJECT_ID', body.id);
  }
  await assignRole(io, env, required(env, 'GATEWAY_ADMIN_OBJECT_ID', guidPattern), apiSp.id,
    api.appRoles.find(item => item.value === 'Gateway.Admin').id, { allowWrite: !existing && !readOnly });
}

export async function completeIdentity(io, env) {
  const url = new URL(required(env, 'GATEWAY_URL'));
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.azurecontainerapps.io') ||
      url.username || url.password || url.port || url.search || url.hash || url.pathname !== '/') {
    throw new SetupError('INVALID_REDIRECT', 'The SPA redirect must be the actual Container Apps HTTPS origin.');
  }
  const id = required(env, 'ENTRA_SPA_OBJECT_ID', guidPattern);
  const { body: app } = await io.graph(env, `/applications/${id}?$select=${select}`);
  appShape(app);
  if (app.appId !== required(env, 'ENTRA_SPA_CLIENT_ID', guidPattern)) throw new SetupError('REGISTRATION_CHANGED', 'SPA registration no longer matches this environment.');
  const redirect = `${url.origin}/auth.html`;
  if (env.ENTRA_SETUP_MODE === 'existing') {
    if (!app.spa?.redirectUris?.includes(redirect)) {
      throw new SetupError('REDIRECT_REQUIRED', `An administrator must register SPA redirect ${redirect} before continuing.`);
    }
  } else {
    const marker = `azd:foundry-ai-gateway:${env.AZURE_SUBSCRIPTION_ID}:${env.AZURE_ENV_NAME}:spa`;
    if (app.notes !== marker) throw new SetupError('REGISTRATION_NOT_OWNED', 'Refusing to modify a SPA registration owned by another environment.');
    await io.graph(env, `/applications/${id}`, { method: 'PATCH', body: { spa: { redirectUris: [redirect] } } });
  }
  await assignRole(io, env, required(env, 'APIM_PRINCIPAL_ID', guidPattern),
    required(env, 'GATEWAY_PROOF_SERVICE_PRINCIPAL_ID', guidPattern),
    required(env, 'GATEWAY_INVOKE_ROLE_ID', guidPattern), { allowWrite: env.ENTRA_SETUP_MODE !== 'existing' });
}
