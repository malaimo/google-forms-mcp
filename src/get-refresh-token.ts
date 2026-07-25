#!/usr/bin/env node
// @ts-ignore
import { google } from 'googleapis';
import * as http from 'http';
import * as crypto from 'crypto';
// @ts-ignore
import open from 'open';
// @ts-ignore
import destroyer from 'server-destroy';

// Before running this script, please set the following environment variables
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const HOST = '127.0.0.1';
const PORT = 3000;
const CALLBACK_PATH = '/oauth2callback';
const REDIRECT_URI = `http://${HOST}:${PORT}${CALLBACK_PATH}`;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Please set the GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET environment variables');
  process.exit(1);
}

// Initialize OAuth2 client
const oauth2Client = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI
);

// Set authentication scopes.
// `drive.file` only grants access to files this app creates, unlike the full
// `drive` scope, which would expose the user's entire Drive.
const scopes = [
  'https://www.googleapis.com/auth/forms',
  'https://www.googleapis.com/auth/drive.file'
];

// Opaque value tying the callback to the request we initiated. Without it, any
// page the user has open could hit the callback with an injected auth code.
const expectedState = crypto.randomBytes(32).toString('hex');

// Escape untrusted values before interpolating them into the HTML responses
function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function page(title: string, body: string): string {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>${title}</title>
    </head>
    <body>
      ${body}
    </body>
    </html>
  `;
}

// Constant-time comparison so the state value can't be guessed byte by byte
function statesMatch(received: string): boolean {
  const a = Buffer.from(received);
  const b = Buffer.from(expectedState);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function main() {
  // Generate authentication URL
  const authorizeUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    prompt: 'consent', // Required to force refresh token acquisition
    state: expectedState
  });

  // Start local server
  const server = http.createServer(async (req, res) => {
    try {
      if (!req.url) {
        throw new Error('No URL in request');
      }

      const requestUrl = new URL(req.url, `http://${HOST}:${PORT}`);

      // Only the callback path answers, and only to GET
      if (req.method !== 'GET' || requestUrl.pathname !== CALLBACK_PATH) {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(page('Not Found', '<h1>Not found</h1>'));
        return;
      }

      const code = requestUrl.searchParams.get('code');
      const state = requestUrl.searchParams.get('state');

      // Reject callbacks we didn't initiate before touching the code
      if (!state || !statesMatch(state)) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(page('Error', '<h1>Invalid state parameter</h1>'));
        console.error('Rejected callback with missing or mismatched state parameter');
        return;
      }

      if (code) {
        // Exchange code for tokens
        const { tokens } = await oauth2Client.getToken(code);

        // Return response
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(page('Authentication Successful', `
            <h1>Authentication Successful!</h1>
            <p>Please close this window and return to the terminal.</p>
        `));

        // Display refresh token
        console.log('\n=== Refresh Token ===');
        console.log(tokens.refresh_token);
        console.log('========================\n');
        console.log('Please set this refresh token to the GOOGLE_REFRESH_TOKEN environment variable.');

        // Stop the server
        server.destroy();
      } else {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(page('Error', '<h1>Authentication code not found</h1>'));
      }
    } catch (e: any) {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(page('Error', `
        <h1>An error occurred</h1>
        <p>${escapeHtml(e?.message || 'Unknown error')}</p>
      `));
      console.error('Error:', e?.message || e);
    }
    // Bind to loopback only, so nobody else on the network can reach the callback
  }).listen(PORT, HOST, () => {
    // Open authentication URL in browser
    console.log('Opening authentication URL...');
    open(authorizeUrl, { wait: false });
  });

  destroyer(server);
}

main().catch(console.error);
