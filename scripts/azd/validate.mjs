import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { root, SetupError } from './common.mjs';

export async function validateLocal(io) {
  const yaml = await readFile(join(root, 'azure.yaml'), 'utf8');
  for (const expected of [
    'path: infra/azd', 'module: gateway', 'language: docker', 'host: containerapp',
    'remoteBuild: true', 'node ./scripts/azd/run.mjs migrate',
    'node ./scripts/azd/run.mjs guard-down',
    'node ./scripts/azd/run.mjs check-target',
  ]) {
    if (!yaml.includes(expected)) throw new SetupError('AZD_CONTRACT', `azure.yaml is missing the required contract: ${expected}`);
  }
  if (/continueOnError:\s*true/.test(yaml)) throw new SetupError('AZD_CONTRACT', 'Deployment hooks must stop on errors.');
  for (const file of ['main', 'gateway', 'migration-job']) {
    const compiled = JSON.parse(await io.command('bicep', ['build', join(root, 'infra', 'azd', `${file}.bicep`), '--stdout']));
    if (!Array.isArray(compiled.resources)) throw new SetupError('BICEP_OUTPUT', `Invalid compiled ${file} template.`);
    if (file === 'gateway') {
      const parameters = JSON.parse(await readFile(join(root, 'infra', 'azd', 'gateway.parameters.json'), 'utf8'));
      if (parameters.parameters?.imageName?.value !== '${GATEWAY_DEPLOY_IMAGE}') {
        throw new SetupError('IMAGE_GATE_MISSING', 'The release must consume the exact migration-approved immutable image.');
      }
    }
  }
  console.info('Offline azd infrastructure and lifecycle contracts passed. No Azure/Graph/database requests were made.');
}
