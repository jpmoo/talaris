// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/**
 * OAuth for Talaris's MCP (docs/WEB.md, *Claude and Morgan*): what a claude.ai connector needs to be let in — the
 * metadata documents (RFC 9728, RFC 8414), dynamic client registration, the authorization code with PKCE (S256
 * only), and the token. Shaped as Hermes Notes' was, which claude.ai already accepted.
 *
 * Approving is signed in by passkey: the consent page answers only to a passkey session (auth.mjs), and sends anyone
 * else to sign in first, then back. The token given is one of auth.mjs's — named, revocable, kept only as its hash.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import * as auth from "./auth.mjs";

const CODE_TTL_MS = 5 * 60_000;
const codes = new Map(); // code → {challenge, redirectUri, clientId, client, until}
const clients = new Map(); // client_id → name, from registration (in memory: a client registers again if lost)

export const publicBase = (prefix) => `${auth.ORIGIN}${prefix}`;
/** Where a client learns how to sign in to the MCP at `${prefix}/mcp`, the well-known segment put before its path. */
export const resourceMetadataUrl = (prefix) => `${auth.ORIGIN}/.well-known/oauth-protected-resource${prefix}/mcp`;

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const redirectOk = (uri) => /^https:\/\//.test(uri) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(uri);

export const protectedResource = (prefix) => ({
  resource: `${publicBase(prefix)}/mcp`,
  authorization_servers: [publicBase(prefix)],
  bearer_methods_supported: ["header"],
  resource_name: "Talaris",
});
export const authServer = (prefix) => ({
  issuer: publicBase(prefix),
  authorization_endpoint: `${publicBase(prefix)}/oauth/authorize`,
  token_endpoint: `${publicBase(prefix)}/oauth/token`,
  registration_endpoint: `${publicBase(prefix)}/oauth/register`,
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none"],
  scopes_supported: ["talaris"],
});

export function register(body) {
  const id = randomUUID();
  const name = typeof body?.client_name === "string" ? body.client_name.slice(0, 80) : "MCP client";
  clients.set(id, name);
  return {
    client_id: id, client_name: name, redirect_uris: Array.isArray(body?.redirect_uris) ? body.redirect_uris : [],
    token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"],
  };
}

function authorizeParams(q) {
  const p = Object.fromEntries(q.entries());
  if (p.response_type !== "code" || !p.client_id || !p.redirect_uri || !p.code_challenge || p.code_challenge_method !== "S256") return null;
  if (!redirectOk(p.redirect_uri)) return null;
  return p;
}

/** The consent page: who is asking, and Approve or Deny. Shown only to a passkey session (the caller sees to it). */
export function consentPage(prefix, q) {
  const p = authorizeParams(q);
  if (!p) return { status: 400, html: "<p>That is not an authorization request Talaris can answer.</p>" };
  const who = clients.get(p.client_id) || "An app";
  const fields = ["client_id", "redirect_uri", "state", "code_challenge"].map((k) => `<input type="hidden" name="${k}" value="${esc(p[k] ?? "")}">`).join("");
  const deny = `${p.redirect_uri}${p.redirect_uri.includes("?") ? "&" : "?"}error=access_denied${p.state ? `&state=${encodeURIComponent(p.state)}` : ""}`;
  return { status: 200, html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Allow access to Talaris</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#1c1f22;color:#e6e8ea;font:15px/1.5 "Barlow Semi Condensed",system-ui,sans-serif;padding:16px}
main{max-width:420px;background:#24282c;border:1px solid #3a3f44;border-radius:14px;padding:26px 24px}
h1{font-size:13px;letter-spacing:4px;text-transform:uppercase;color:#c98a5b;margin:0 0 10px}p{color:#9aa1a8;margin:0 0 18px}
b{color:#e6e8ea}.row{display:flex;gap:10px;align-items:center}button{padding:10px 20px;border-radius:9px;border:1px solid #c98a5b;background:#c98a5b;color:#1c1f22;font:inherit;font-weight:600;cursor:pointer}
a{color:#9aa1a8}</style></head><body><main><h1>Talaris</h1>
<p><b>${esc(who)}</b> asks to use your Talaris: your tasks, projects, notes, people, calendar and canvases — reading them and changing them, as you would.</p>
<p>It gets a key of its own, listed in Talaris and taken back there whenever you like.</p>
<form method="post" action="${esc(publicBase(prefix))}/oauth/approve"><div class="row">${fields}<button type="submit">Allow</button><a href="${esc(deny)}">Deny</a></div></form>
</main></body></html>` };
}

/** Approved: a code for the client, back to where it waits. */
export function approve(form) {
  const p = { response_type: "code", code_challenge_method: "S256", ...form };
  if (!p.client_id || !p.redirect_uri || !p.code_challenge || !redirectOk(p.redirect_uri)) return { status: 400, error: "That approval is not one Talaris asked for" };
  const code = randomBytes(24).toString("base64url");
  codes.set(code, { challenge: p.code_challenge, redirectUri: p.redirect_uri, clientId: p.client_id, client: clients.get(p.client_id) || "MCP client", until: Date.now() + CODE_TTL_MS });
  const sep = p.redirect_uri.includes("?") ? "&" : "?";
  return { status: 302, location: `${p.redirect_uri}${sep}code=${encodeURIComponent(code)}${p.state ? `&state=${encodeURIComponent(p.state)}` : ""}` };
}

/** The code, and its verifier, exchanged for a token. */
export function token(form) {
  if (form.grant_type !== "authorization_code" || !form.code || !form.code_verifier) return { status: 400, body: { error: "invalid_request" } };
  const entry = codes.get(form.code);
  codes.delete(form.code);
  if (!entry || entry.until < Date.now()) return { status: 400, body: { error: "invalid_grant" } };
  if (form.redirect_uri && form.redirect_uri !== entry.redirectUri) return { status: 400, body: { error: "invalid_grant" } };
  if (createHash("sha256").update(form.code_verifier).digest("base64url") !== entry.challenge) return { status: 400, body: { error: "invalid_grant" } };
  const t = auth.makeToken({ client: "claude", name: `${entry.client} (${new Date().toISOString().slice(0, 10)})` });
  return { status: 200, body: { access_token: t, token_type: "Bearer", scope: "talaris" } };
}
