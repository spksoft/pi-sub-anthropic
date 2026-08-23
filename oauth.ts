/**
 * Anthropic OAuth flow, ported from omp (@oh-my-pi/pi-ai)
 * `src/registry/oauth/anthropic.ts`.
 *
 * Key divergences from pi 0.83.0's built-in flow (verified by reading both
 * sources on disk):
 *
 *   | thing        | pi 0.83.0                              | omp 17.4.2                        |
 *   |--------------|----------------------------------------|-----------------------------------|
 *   | token URL    | platform.claude.com/v1/oauth/token      | api.anthropic.com/v1/oauth/token  |
 *   | callback port| 53692                                  | 54545                             |
 *   | bootstrap    | none                                   | /api/claude_cli/bootstrap         |
 *   | identity     | not captured                           | account/org uuid + email captured |
 *
 * The client id, authorize URL and scopes are identical in both.
 */

import nodeCrypto from "node:crypto";
import http from "node:http";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { claudeCodeVersion } from "./fingerprint.ts";

const decode = (s: string) => atob(s);

const CLIENT_ID = decode("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl");
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
/** omp uses api.anthropic.com here; pi 0.83.0 uses platform.claude.com. */
const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
const BOOTSTRAP_URL = "https://api.anthropic.com/api/claude_cli/bootstrap";
const CLAUDE_CODE_BOOTSTRAP_MODEL = "claude-opus-4-8";
const CLAUDE_CODE_BOOTSTRAP_USER_AGENT = `claude-code/${claudeCodeVersion}`;

/** omp's callback port. Deliberately different from pi's 53692 so both can coexist. */
const CALLBACK_PORT = 54545;
const CALLBACK_PATH = "/callback";

/**
 * Scopes required for direct OAuth-token inference (user:inference) plus
 * account/session management. NOTE from omp: platform.claude.com/oauth/authorize
 * issues console tokens (org:create_api_key only) and does NOT grant
 * user:inference — the claude.ai endpoint is required for direct inference.
 */
const SCOPES =
	"org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

export interface AnthropicIdentity {
	accountId?: string;
	email?: string;
	orgId?: string;
	orgName?: string;
}

/** OAuthCredentials plus the identity fields omp lifts off the token response. */
export type OmpOAuthCredentials = OAuthCredentials & AnthropicIdentity;

interface AnthropicTokenResponse {
	access_token: string;
	refresh_token: string;
	expires_in: number;
	account?: { uuid?: string; email_address?: string };
	organization?: { uuid?: string; name?: string };
}

interface AnthropicBootstrapResponse {
	oauth_account?: {
		account_uuid?: string;
		account_email?: string;
		organization_uuid?: string;
		organization_name?: string;
	};
}

const nonEmpty = (v: unknown): string | undefined =>
	typeof v === "string" && v.length > 0 ? v : undefined;

function generatePKCE(): { verifier: string; challenge: string } {
	const bytes = nodeCrypto.randomBytes(32);
	const b64url = (b: Buffer) =>
		b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
	const verifier = b64url(bytes);
	const challenge = b64url(nodeCrypto.createHash("sha256").update(verifier).digest());
	return { verifier, challenge };
}

async function postJson(url: string, body: unknown): Promise<string> {
	const response = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(30_000),
	});
	const text = await response.text();
	if (!response.ok) {
		throw new Error(`HTTP ${response.status}: ${text}`);
	}
	return text;
}

function parseTokenResponse(responseBody: string, operation: string): AnthropicTokenResponse {
	try {
		return JSON.parse(responseBody) as AnthropicTokenResponse;
	} catch (error) {
		throw new Error(
			`Anthropic ${operation} returned invalid JSON. url=${TOKEN_URL}; body=${responseBody}; details=${String(error)}`,
		);
	}
}

function extractAccountFromTokenResponse(data: AnthropicTokenResponse): AnthropicIdentity {
	return {
		accountId: nonEmpty(data.account?.uuid),
		email: nonEmpty(data.account?.email_address),
		orgId: nonEmpty(data.organization?.uuid),
		orgName: nonEmpty(data.organization?.name),
	};
}

/** omp's bootstrap round-trip; fills identity gaps the token response leaves. */
async function fetchBootstrapIdentity(accessToken: string): Promise<AnthropicIdentity> {
	const url = `${BOOTSTRAP_URL}?entrypoint=cli&model=${encodeURIComponent(CLAUDE_CODE_BOOTSTRAP_MODEL)}`;
	const response = await fetch(url, {
		method: "GET",
		headers: {
			Accept: "application/json, text/plain, */*",
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json",
			"User-Agent": CLAUDE_CODE_BOOTSTRAP_USER_AGENT,
			"anthropic-beta": "oauth-2025-04-20",
		},
		signal: AbortSignal.timeout(30_000),
	});
	const responseBody = await response.text();
	if (!response.ok) {
		throw new Error(`HTTP ${response.status}: ${responseBody}`);
	}
	const data = JSON.parse(responseBody) as AnthropicBootstrapResponse;
	return {
		accountId: nonEmpty(data.oauth_account?.account_uuid),
		email: nonEmpty(data.oauth_account?.account_email),
		orgId: nonEmpty(data.oauth_account?.organization_uuid),
		orgName: nonEmpty(data.oauth_account?.organization_name),
	};
}

/**
 * `includeOrg` is login-only: the org an access token is scoped to is captured
 * once when the credential is created and deliberately never refreshed —
 * rewriting identity during background refreshes could silently re-key stored
 * credentials.
 */
async function resolveAccountIdentity(
	data: AnthropicTokenResponse,
	options?: { includeOrg?: boolean },
): Promise<AnthropicIdentity> {
	const identity = extractAccountFromTokenResponse(data);
	const orgSatisfied = !options?.includeOrg || identity.orgId !== undefined;
	if (identity.accountId && identity.email && orgSatisfied) return identity;
	try {
		const bootstrap = await fetchBootstrapIdentity(data.access_token);
		return {
			accountId: identity.accountId ?? bootstrap.accountId,
			email: identity.email ?? bootstrap.email,
			orgId: identity.orgId ?? bootstrap.orgId,
			orgName: identity.orgName ?? bootstrap.orgName,
		};
	} catch {
		return identity;
	}
}

function parseAuthorizationInput(input: string): { code?: string; state?: string } {
	const value = input.trim();
	if (!value) return {};
	try {
		const url = new URL(value);
		return {
			code: url.searchParams.get("code") ?? undefined,
			state: url.searchParams.get("state") ?? undefined,
		};
	} catch {
		// Not a URL — treat as a raw "code#state" pasted from the browser.
		const hashIdx = value.indexOf("#");
		if (hashIdx >= 0) {
			return { code: value.slice(0, hashIdx), state: value.slice(hashIdx + 1) || undefined };
		}
		return { code: value };
	}
}

/**
 * Runs a localhost callback server, races it against a manual paste prompt,
 * and exchanges whichever authorization code arrives first.
 */
export async function loginAnthropic(callbacks: OAuthLoginCallbacks): Promise<OmpOAuthCredentials> {
	const { verifier, challenge } = generatePKCE();
	const state = nodeCrypto.randomUUID();
	const redirectUri = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;

	let server: http.Server | undefined;

	const callbackPromise = new Promise<{ code: string; state: string }>((resolve, reject) => {
		server = http.createServer((req, res) => {
			if (!req.url?.startsWith(CALLBACK_PATH)) {
				res.writeHead(404).end();
				return;
			}
			const url = new URL(req.url, `http://localhost:${CALLBACK_PORT}`);
			const code = url.searchParams.get("code");
			const returnedState = url.searchParams.get("state");
			if (code) {
				res.writeHead(200, { "Content-Type": "text/html" }).end(
					"<html><body><h2>Login complete.</h2><p>You can close this tab and return to pi.</p></body></html>",
				);
				resolve({ code, state: returnedState ?? state });
			} else {
				res.writeHead(400, { "Content-Type": "text/html" }).end(
					"<html><body><h2>Login failed.</h2></body></html>",
				);
				reject(new Error("OAuth callback carried no authorization code"));
			}
		});
		server.on("error", () => {
			// Port busy (e.g. another CLI is mid-login) — fall back to manual paste.
		});
		server.listen(CALLBACK_PORT, "127.0.0.1");
	});

	const authParams = new URLSearchParams({
		code: "true",
		client_id: CLIENT_ID,
		response_type: "code",
		redirect_uri: redirectUri,
		scope: SCOPES,
		code_challenge: challenge,
		code_challenge_method: "S256",
		state,
	});

	callbacks.onAuth({ url: `${AUTHORIZE_URL}?${authParams.toString()}` });

	const manualPromise = callbacks
		.onPrompt({
			message:
				"Complete login in your browser. If the browser can't reach this machine, paste the redirect URL or code here:",
		})
		.then((input) => {
			const parsed = parseAuthorizationInput(input);
			if (!parsed.code) throw new Error("No authorization code provided");
			return { code: parsed.code, state: parsed.state ?? state };
		});

	let received: { code: string; state: string };
	try {
		received = await Promise.race([callbackPromise, manualPromise]);
	} finally {
		server?.close();
	}

	const responseBody = await postJson(TOKEN_URL, {
		grant_type: "authorization_code",
		client_id: CLIENT_ID,
		code: received.code,
		state: received.state,
		redirect_uri: redirectUri,
		code_verifier: verifier,
	});

	const tokenData = parseTokenResponse(responseBody, "token exchange");
	const identity = await resolveAccountIdentity(tokenData, { includeOrg: true });

	return {
		refresh: tokenData.refresh_token,
		access: tokenData.access_token,
		expires: Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000,
		...identity,
	};
}

export async function refreshAnthropicToken(
	credentials: OmpOAuthCredentials,
): Promise<OmpOAuthCredentials> {
	const responseBody = await postJson(TOKEN_URL, {
		grant_type: "refresh_token",
		client_id: CLIENT_ID,
		refresh_token: credentials.refresh,
	});
	const data = parseTokenResponse(responseBody, "token refresh");

	// Identity is captured at login and deliberately not rewritten on refresh.
	return {
		refresh: data.refresh_token || credentials.refresh,
		access: data.access_token,
		expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
		accountId: credentials.accountId,
		email: credentials.email,
		orgId: credentials.orgId,
		orgName: credentials.orgName,
	};
}

export { CALLBACK_PORT, SCOPES, TOKEN_URL, AUTHORIZE_URL };
