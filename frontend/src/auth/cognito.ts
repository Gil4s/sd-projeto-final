import type { AuthSession } from '../types';

const SESSION_KEY = 'taskcloud_auth_session_v1';
const PKCE_VERIFIER_KEY = 'taskcloud_pkce_verifier';
const OAUTH_STATE_KEY = 'taskcloud_oauth_state';

export const COGNITO_CONFIG = {
  domain: (import.meta.env.VITE_COGNITO_DOMAIN || '').replace(/\/+$/, ''),
  clientId: (import.meta.env.VITE_COGNITO_CLIENT_ID || '').trim(),
  userPoolId: (import.meta.env.VITE_COGNITO_USER_POOL_ID || 'us-east-1_h35pbTemC').trim(),
  apiUrl: (
    import.meta.env.VITE_API_URL || 'https://api.guilhermeag.grupo-06.sd.ufersa.dev.br'
  ).replace(/\/+$/, ''),
};

export function isCognitoConfigured(): boolean {
  return Boolean(
    COGNITO_CONFIG.domain &&
      COGNITO_CONFIG.clientId &&
      !COGNITO_CONFIG.domain.includes('SEU-DOMINIO') &&
      !COGNITO_CONFIG.clientId.includes('COLE_AQUI'),
  );
}

function base64UrlEncode(buffer: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < buffer.length; i += 1) {
    binary += String.fromCharCode(buffer[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generateRandomString(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  window.crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

async function computePkceChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const digest = await window.crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(new Uint8Array(digest));
}

export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    const bytes = Uint8Array.from(atob(padded), (ch) => ch.charCodeAt(0));
    const json = new TextDecoder().decode(bytes);
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function startCognitoLogin(mode: 'login' | 'signup' = 'login'): Promise<void> {
  if (!isCognitoConfigured()) {
    throw new Error(
      'Cognito ainda não configurado. Defina VITE_COGNITO_DOMAIN e VITE_COGNITO_CLIENT_ID.',
    );
  }

  const verifier = generateRandomString(48);
  const state = generateRandomString(24);
  const challenge = await computePkceChallenge(verifier);

  sessionStorage.setItem(PKCE_VERIFIER_KEY, verifier);
  sessionStorage.setItem(OAUTH_STATE_KEY, state);

  const redirectUri = window.location.origin;
  const params = new URLSearchParams({
    client_id: COGNITO_CONFIG.clientId,
    response_type: 'code',
    scope: 'openid email profile',
    redirect_uri: redirectUri,
    state,
    code_challenge_method: 'S256',
    code_challenge: challenge,
  });

  const endpoint = mode === 'signup' ? '/signup' : '/login';
  window.location.assign(`${COGNITO_CONFIG.domain}${endpoint}?${params.toString()}`);
}

export async function handleCognitoCallbackIfPresent(): Promise<AuthSession | null> {
  const url = new URL(window.location.href);
  const code = url.searchParams.get('code');
  const returnedState = url.searchParams.get('state');
  const oauthError = url.searchParams.get('error');

  if (oauthError) {
    const desc = url.searchParams.get('error_description') || oauthError;
    window.history.replaceState({}, '', '/');
    throw new Error(`Falha na autenticação Cognito: ${desc}`);
  }

  if (!code) return null;

  const expectedState = sessionStorage.getItem(OAUTH_STATE_KEY);
  const verifier = sessionStorage.getItem(PKCE_VERIFIER_KEY);
  sessionStorage.removeItem(OAUTH_STATE_KEY);
  sessionStorage.removeItem(PKCE_VERIFIER_KEY);

  window.history.replaceState({}, '', '/');

  if (!verifier || !expectedState || returnedState !== expectedState) {
    throw new Error('Validação de segurança OAuth2 (state/PKCE) falhou. Tente entrar novamente.');
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: COGNITO_CONFIG.clientId,
    code,
    redirect_uri: window.location.origin,
    code_verifier: verifier,
  });

  const response = await fetch(`${COGNITO_CONFIG.domain}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Erro ao trocar código OAuth2 por JWT (${response.status}): ${detail}`);
  }

  const tokens = (await response.json()) as {
    id_token: string;
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  const claims = decodeJwtPayload(tokens.id_token) || {};
  const session: AuthSession = {
    idToken: tokens.id_token,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000,
    email: typeof claims.email === 'string' ? claims.email : null,
    sub: String(claims.sub || ''),
    username: String(claims['cognito:username'] || claims.email || claims.sub || 'Usuário'),
  };

  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  return session;
}

export function getStoredSession(): AuthSession | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AuthSession;
    if (!parsed?.idToken || !parsed?.expiresAt) return null;
    if (Date.now() >= parsed.expiresAt - 60_000) {
      sessionStorage.removeItem(SESSION_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function clearLocalSession(): void {
  sessionStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem(PKCE_VERIFIER_KEY);
  sessionStorage.removeItem(OAUTH_STATE_KEY);
}

export function logoutCognito(): void {
  clearLocalSession();
  if (!isCognitoConfigured()) {
    window.location.assign('/');
    return;
  }
  const params = new URLSearchParams({
    client_id: COGNITO_CONFIG.clientId,
    logout_uri: window.location.origin,
  });
  window.location.assign(`${COGNITO_CONFIG.domain}/logout?${params.toString()}`);
}
