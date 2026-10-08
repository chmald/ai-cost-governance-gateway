import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
export const root = fileURLToPath(new URL('../../', import.meta.url));
export const ARM = 'https://management.azure.com';
export const GRAPH = 'https://graph.microsoft.com/v1.0';
export const appApiVersion = '2025-01-01';
export const guidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const armNamePattern = /^[a-zA-Z0-9][a-zA-Z0-9_.()-]{0,89}$/;

export class SetupError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function required(env, key, pattern) {
  const value = env[key]?.trim();
  if (!value || (pattern && !pattern.test(value))) {
    throw new SetupError('CONFIG_REQUIRED', `Set a valid ${key} with azd env set ${key} <value>.`);
  }
  return value;
}

export function publicOrigin(value, suffix) {
  let url;
  try { url = new URL(value); } catch { throw new SetupError('INVALID_ENDPOINT', 'Expected an HTTPS Azure endpoint.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      url.port || url.pathname !== '/' || !url.hostname.endsWith(suffix)) {
    throw new SetupError('INVALID_ENDPOINT', 'The endpoint is not the expected credential-free HTTPS Azure origin.');
  }
  return url.origin;
}

export function resourcePath(env, provider, type, name) {
  const sub = required(env, 'AZURE_SUBSCRIPTION_ID', guidPattern);
  const group = required(env, 'AZURE_RESOURCE_GROUP', armNamePattern);
  if (!armNamePattern.test(name)) throw new SetupError('INVALID_RESOURCE_NAME', 'Invalid Azure resource name.');
  return `/subscriptions/${sub}/resourceGroups/${encodeURIComponent(group)}/providers/${provider}/${type}/${encodeURIComponent(name)}`;
}

function safeErrorCode(body) {
  const code = body?.error?.code;
  return typeof code === 'string' && /^[a-zA-Z0-9_.-]{1,100}$/.test(code) ? code : 'REQUEST_FAILED';
}

export class AzureIo {
  constructor({ fetcher = fetch, run = execute, delay = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
    this.fetcher = fetcher;
    this.run = run;
    this.delay = delay;
    this.tokens = new Map();
  }

  async command(name, args) {
    try {
      const executable = process.platform === 'win32' && name === 'azd' ? 'azd.exe' : name;
      const result = await this.run(executable, args, {
        cwd: root, windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 120_000,
        env: { ...process.env, AZD_CHECK_VERSION: 'false' },
      });
      return result.stdout.trim();
    } catch {
      // CLI diagnostics can include access tokens or complete environment values.
      throw new SetupError('CLI_FAILED', `${name} ${args[0] ?? ''} failed. Verify the tool and selected azd environment; do not enable secret/debug logging.`);
    }
  }

  async environment() {
    const raw = await this.command('azd', ['env', 'get-values', '--output', 'json']);
    let values;
    try { values = JSON.parse(raw); } catch { throw new SetupError('INVALID_ENVIRONMENT', 'azd did not return a JSON environment.'); }
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new SetupError('INVALID_ENVIRONMENT', 'Invalid azd environment.');
    return { ...process.env, ...values };
  }

  async save(env, key, value) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || /TOKEN|PASSWORD|SECRET/.test(key) ||
        typeof value !== 'string' || /[\r\n\0]/.test(value)) {
      throw new SetupError('UNSAFE_ENVIRONMENT_VALUE', 'Refusing to persist a secret or invalid environment value.');
    }
    await this.command('azd', ['env', 'set', key, value]);
    env[key] = value;
  }

  async token(env, scope) {
    const tenant = env.AZURE_TENANT_ID ?? '';
    const key = `${tenant}:${scope}`;
    const cached = this.tokens.get(key);
    if (cached && cached.until > Date.now()) return cached.token;
    const args = ['auth', 'token', '--scope', scope];
    if (tenant) args.push('--tenant-id', required(env, 'AZURE_TENANT_ID', guidPattern));
    let raw;
    try { raw = await this.command('azd', args); } catch {
      throw new SetupError('LOGIN_REQUIRED', `Cannot acquire the required ${scope.includes('graph.microsoft') ? 'Microsoft Graph' : 'Azure'} token. Run azd auth login --tenant-id <AZURE_TENANT_ID> for the selected tenant. Graph setup may require a tenant administrator or ENTRA_SETUP_MODE=existing.`);
    }
    const token = raw.startsWith('{') ? JSON.parse(raw).token : raw;
    if (typeof token !== 'string' || token.length < 20 || /[\r\n\s]/.test(token)) {
      throw new SetupError('INVALID_TOKEN_RESULT', 'azd returned an invalid access-token result.');
    }
    this.tokens.set(key, { token, until: Date.now() + 240_000 });
    return token;
  }

  async request(url, { method = 'GET', headers = {}, body, form } = {}) {
    let response;
    try {
      response = await this.fetcher(url, {
        method, redirect: 'error', signal: AbortSignal.timeout(60_000),
        headers: {
          ...headers,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        ...(form ? { body: new URLSearchParams(form).toString() } : {}),
      });
    } catch {
      throw new SetupError('NETWORK_FAILURE', 'Azure request failed or timed out. Its outcome may be uncertain; rerun the idempotent setup after checking the target.');
    }
    let parsed = null;
    if (method !== 'HEAD' && response.status !== 204) {
      if (Number(response.headers.get('content-length') || 0) > 4_000_000) {
        await response.body?.cancel();
        throw new SetupError('RESPONSE_LIMIT', 'Azure response exceeded the safety limit.');
      }
      const reader = response.body?.getReader();
      const chunks = [];
      let size = 0;
      if (reader) {
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 4_000_000) throw new SetupError('RESPONSE_LIMIT', 'Azure response exceeded the safety limit.');
            chunks.push(value);
          }
        } finally { await reader.cancel(); }
      }
      const text = Buffer.concat(chunks).toString('utf8');
      if (text) {
        try { parsed = JSON.parse(text); } catch {
          throw new SetupError('INVALID_RESPONSE', `Azure returned an unexpected non-JSON response (HTTP ${response.status}).`, response.status);
        }
      }
    }
    if (!response.ok) {
      const code = safeErrorCode(parsed);
      const graph = new URL(url).hostname === 'graph.microsoft.com';
      throw new SetupError(code,
        `${graph ? 'Microsoft Graph' : 'Azure'} request failed (HTTP ${response.status}, ${code}).` +
        (graph && [401, 403].includes(response.status)
          ? ' A tenant administrator must authorize application/role-assignment management, or supply preconfigured registrations with ENTRA_SETUP_MODE=existing. Runtime identities must not receive broad Graph permissions.'
          : ' Check permissions, regional availability, and the target resource before retrying.'),
        response.status);
    }
    return { body: parsed, headers: response.headers, status: response.status };
  }

  async arm(env, path, options = {}) {
    const prefix = `/subscriptions/${required(env, 'AZURE_SUBSCRIPTION_ID', guidPattern)}`;
    if (!path.toLowerCase().startsWith(`${prefix.toLowerCase()}/`) && !path.toLowerCase().startsWith(`${prefix.toLowerCase()}?`)) {
      throw new SetupError('TARGET_MISMATCH', 'ARM request escaped the selected subscription.');
    }
    return this.request(`${ARM}${path}`, { ...options, headers: {
      Authorization: `Bearer ${await this.token(env, `${ARM}/.default`)}`, ...options.headers,
    } });
  }

  async graph(env, path, options = {}) {
    if (!path.startsWith('/') || path.startsWith('//')) throw new SetupError('INVALID_GRAPH_PATH', 'Invalid Microsoft Graph path.');
    return this.request(`${GRAPH}${path}`, { ...options, headers: {
      Authorization: `Bearer ${await this.token(env, 'https://graph.microsoft.com/.default')}`, ...options.headers,
    } });
  }

  async prompt(env, key, label, defaultValue = '') {
    if (env[key]) return env[key];
    if (!process.stdin.isTTY || ['true', '1'].includes(env.AZD_NON_INTERACTIVE) || env.CI) {
      if (defaultValue) { await this.save(env, key, defaultValue); return defaultValue; }
      return required(env, key);
    }
    const input = createInterface({ input: process.stdin, output: process.stdout });
    let answer;
    try { answer = (await input.question(`${label}${defaultValue ? ` [${defaultValue}]` : ''}: `)).trim() || defaultValue; }
    finally { input.close(); }
    if (!answer) throw new SetupError('CONFIG_REQUIRED', `${key} is required.`);
    await this.save(env, key, answer);
    return answer;
  }
}

export async function waitFor(io, action, finished, { attempts = 180, delay = 5_000, label = 'Azure operation' } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const result = await action();
    if (finished(result)) return result;
    await io.delay(delay);
  }
  throw new SetupError('OPERATION_TIMEOUT', `${label} did not complete in time. No application release is authorized by this hook.`);
}

export async function readEventually(io, action) {
  for (let attempt = 0; attempt < 12; attempt++) {
    try { return await action(); } catch (error) {
      if (!(error instanceof SetupError) || ![404, 429, 503].includes(error.status) || attempt === 11) throw error;
      await io.delay(5_000);
    }
  }
}
