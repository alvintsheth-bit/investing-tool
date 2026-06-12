/**
 * Robinhood OAuth one-time authentication.
 * Run once: node robinhood-auth.js
 * Saves access + refresh tokens to .env for agent.js to use.
 */

import { createHash, randomBytes } from 'crypto';
import { createServer } from 'http';
import { exec } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { config } from 'dotenv';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_FILE   = join(__dirname, '.env');
const REDIRECT   = 'http://localhost:8765/callback';
const REGISTER   = 'https://agent.robinhood.com/oauth/trading/register';
const TOKEN_URL  = 'https://api.robinhood.com/oauth2/token/';
const AUTH_URL   = 'https://robinhood.com/oauth';

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function updateEnv(key, value) {
  let env = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf-8') : '';
  const rx = new RegExp(`^${key}=.*$`, 'm');
  if (rx.test(env)) {
    env = env.replace(rx, `${key}=${value}`);
  } else {
    env = env.trimEnd() + `\n${key}=${value}\n`;
  }
  writeFileSync(ENV_FILE, env);
}

async function main() {
  // ── 1. Register a dynamic OAuth client (skip if already have one) ───────────
  let client_id = process.env.ROBINHOOD_CLIENT_ID;

  if (client_id) {
    console.log(`\n🔐 Reusing existing client ID: ${client_id}`);
  } else {
    console.log('\n🔐 Registering Robinhood OAuth client...');
    const regRes = await fetch(REGISTER, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: [REDIRECT],
        client_name: 'investing-tool',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      }),
    });

    if (!regRes.ok) {
      console.error('Registration failed:', await regRes.text());
      process.exit(1);
    }

    ({ client_id } = await regRes.json());
    updateEnv('ROBINHOOD_CLIENT_ID', client_id);
    console.log(`   Client ID: ${client_id}`);
  }

  // ── 2. PKCE ─────────────────────────────────────────────────────────────────
  const verifier   = b64url(randomBytes(32));
  const challenge  = b64url(createHash('sha256').update(verifier).digest());
  const state      = b64url(randomBytes(16));

  const params = new URLSearchParams({
    response_type: 'code',
    client_id,
    redirect_uri:           REDIRECT,
    code_challenge:         challenge,
    code_challenge_method: 'S256',
    scope:                 'internal',
    state,
  });

  const authUrl = `${AUTH_URL}?${params}`;

  // ── 3. Local callback server ─────────────────────────────────────────────────
  const code = await new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost:8765');
        const gotCode  = url.searchParams.get('code');
        const gotState = url.searchParams.get('state');

        if (gotState !== state) {
          res.writeHead(400).end('State mismatch — possible CSRF. Try again.');
          server.close();
          reject(new Error('State mismatch'));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'text/html' }).end(`
          <html><body style="font-family:sans-serif;text-align:center;padding:60px">
          <h2>✅ Authenticated!</h2>
          <p>You can close this tab. The investing agent is now connected to Robinhood.</p>
          </body></html>`);

        server.close();
        resolve(gotCode);
      } catch (e) {
        server.close();
        reject(e);
      }
    });

    server.listen(8765, () => {
      console.log('\n🌐 Opening Robinhood login in your browser...');
      console.log('   (if it doesn\'t open, visit the URL below manually)\n');
      console.log(authUrl + '\n');
      exec(`open "${authUrl}"`);
    });

    // 5-minute timeout
    setTimeout(() => { server.close(); reject(new Error('Timeout — no login within 5 minutes')); }, 300_000);
  });

  // ── 4. Exchange code for tokens ──────────────────────────────────────────────
  console.log('⏳ Exchanging code for tokens...');
  const tokRes = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'authorization_code',
      client_id,
      code,
      redirect_uri:  REDIRECT,
      code_verifier: verifier,
    }),
  });

  if (!tokRes.ok) {
    console.error('Token exchange failed:', await tokRes.text());
    process.exit(1);
  }

  const { access_token, refresh_token, expires_in } = await tokRes.json();

  // ── 5. Persist to .env ───────────────────────────────────────────────────────
  updateEnv('ROBINHOOD_CLIENT_ID',     client_id);
  updateEnv('ROBINHOOD_ACCESS_TOKEN',  access_token);
  updateEnv('ROBINHOOD_REFRESH_TOKEN', refresh_token);

  console.log('✅ Done! Tokens saved to .env');
  console.log(`   Access token expires in: ${Math.round(expires_in / 3600)}h`);
  console.log('\nRun the agent: npm run analyze\n');
}

main().catch(err => { console.error('\n❌', err.message); process.exit(1); });
