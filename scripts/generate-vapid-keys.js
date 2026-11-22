// Generate a VAPID key pair for push alerts.
//
//   npm run vapid:generate
//       Print both keys (for local development in .dev.vars).
//
//   npm run vapid:generate -- --secret [--env production]
//       Store the private key straight in the Worker secret VAPID_PRIVATE_KEY
//       (it never appears on screen) and print the matching public key for
//       wrangler.toml.
//
// Generate once and keep the pair: new keys mean every device has to turn
// alerts on again.

import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = privateKey.export({ format: 'jwk' });
const raw = (s) => Buffer.from(s, 'base64url');
const publicKey = Buffer.concat([Buffer.from([4]), raw(jwk.x), raw(jwk.y)]).toString('base64url');

const args = process.argv.slice(2);

if (args.includes('--secret')) {
  const envIndex = args.indexOf('--env');
  const envArgs = envIndex >= 0 ? ['--env', args[envIndex + 1] ?? ''] : [];
  const result = spawnSync('npx', ['wrangler', 'secret', 'put', 'VAPID_PRIVATE_KEY', ...envArgs], {
    input: jwk.d,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  if (result.status !== 0) {
    console.error('\nCould not store the secret, so no key was kept. Nothing changed.');
    process.exit(result.status ?? 1);
  }
  console.log('\nPrivate key stored. Now put this line in wrangler.toml under [vars]');
  console.log(`(or [env.<name>.vars]) and deploy:\n\nVAPID_PUBLIC_KEY = "${publicKey}"`);
} else {
  console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
  console.log(`VAPID_PRIVATE_KEY=${jwk.d}`);
}
