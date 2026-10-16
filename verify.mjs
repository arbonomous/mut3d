// Builds the app from this repo and compares it, byte for byte, with the page served live.
// Usage: npm run verify   (default site below; pass another URL as the first argument)
import { execSync } from 'child_process'; import fs from 'fs'; import crypto from 'crypto';
const site = process.argv[2] || 'https://arbonomous-private-room.pages.dev/';
execSync('node build.mjs', { stdio: 'inherit' });
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const mine = fs.readFileSync('dist/index.html');
const live = Buffer.from(await (await fetch(site, { cache: 'no-store' })).arrayBuffer());
console.log('built from this repo:', sha(mine)); console.log('served by', site, sha(live));
console.log(sha(mine) === sha(live) ? 'MATCH: the live page is exactly this source.' : 'NO MATCH: the live page differs from this source (a newer commit may not be deployed yet).');
process.exit(sha(mine) === sha(live) ? 0 : 1);
