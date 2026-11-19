import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Where a host started by hand listens, and its API token. `host.json` names
 * the port only: the host hands its token to whoever started it, on its first
 * output line (#130). Copy that line's `token` into JOUZU_E2E_HOST_TOKEN.
 */
export function hostAccess(home) {
  const token = process.env.JOUZU_E2E_HOST_TOKEN;
  if (!token) {
    console.error('JOUZU_E2E_HOST_TOKEN is not set: copy "token" from the first line the host printed.');
    process.exit(2);
  }
  const { port } = JSON.parse(readFileSync(join(home, 'host.json'), 'utf8'));
  return { port, token };
}
