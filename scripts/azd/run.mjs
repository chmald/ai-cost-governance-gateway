import { AzureIo, SetupError } from './common.mjs';
import { completeIdentity } from './identity.mjs';
import { checkTarget, guardDown, migrateRelease, prepare, verifyRelease } from './workflow.mjs';
import { validateLocal } from './validate.mjs';

const actions = { prepare, 'check-target': checkTarget, identity: completeIdentity, migrate: migrateRelease, verify: verifyRelease, 'guard-down': guardDown };

try {
  if ((!actions[process.argv[2]] && process.argv[2] !== 'check') || process.argv.length !== 3) {
    throw new SetupError('INVALID_ACTION', 'Expected check, prepare, check-target, identity, migrate, verify, or guard-down.');
  }
  if (Number(process.versions.node.split('.')[0]) !== 24) throw new SetupError('NODE_VERSION', 'Use Node.js 24 for the deployment hooks.');
  const io = new AzureIo();
  if (process.argv[2] === 'check') await validateLocal(io);
  else await actions[process.argv[2]](io, await io.environment());
} catch (error) {
  if (error instanceof SetupError) console.error(`${error.code}: ${error.message}`);
  else console.error('SETUP_FAILED: Deployment setup failed. No further step was started. Check configuration and retry the idempotent workflow; raw provider/credential diagnostics are not logged.');
  process.exitCode = 1;
}
