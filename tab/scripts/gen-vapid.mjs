// Prints a fresh VAPID key pair for push notifications.
// Run once: npm run vapid
// The public key goes in wrangler.toml [vars]; the private key is set
// with `npx wrangler secret put VAPID_PRIVATE_KEY`. Generating a new
// pair invalidates every existing subscription — devices resubscribe
// the next time someone flips the notifications rocker.
import { generateKeyPairSync } from 'node:crypto';

const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pub = publicKey.export({ format: 'jwk' });
const priv = privateKey.export({ format: 'jwk' });
const raw = Buffer.concat([
  Buffer.from([4]),
  Buffer.from(pub.x, 'base64url'),
  Buffer.from(pub.y, 'base64url')
]);

console.log('VAPID_PUBLIC_KEY — paste into wrangler.toml [vars]:');
console.log('  ' + raw.toString('base64url'));
console.log('');
console.log('VAPID_PRIVATE_KEY — set with: npx wrangler secret put VAPID_PRIVATE_KEY');
console.log('  ' + priv.d);
