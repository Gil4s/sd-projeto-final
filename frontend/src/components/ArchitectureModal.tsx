import { useState } from 'react';
import { Check, Copy, Database, Globe, KeyRound, Play, Server, ShieldAlert, ShieldCheck } from 'lucide-react';
import { ModalDialog } from './ModalDialog';
import { COGNITO_CONFIG, decodeJwtPayload } from '../auth/cognito';
import { apiClient } from '../api/client';
import type { AuthSession, RawTestResult } from '../types';

interface ArchitectureModalProps {
  open: boolean;
  onClose: () => void;
  session: AuthSession | null;
}

export function ArchitectureModal({ open, onClose, session }: ArchitectureModalProps) {
  const [testing, setTesting] = useState<string | null>(null);
  const [result, setResult] = useState<RawTestResult | null>(null);
  const [copiedToken, setCopiedToken] = useState(false);

  const claims = session ? decodeJwtPayload(session.idToken) : null;

  async function runTest(label: string, path: string, withAuth: boolean) {
    setTesting(label);
    try {
      const res = await apiClient.testRawRequest(path, withAuth ? session?.idToken : null);
      setResult(res);
    } catch (err) {
      setResult({
        endpoint: `${COGNITO_CONFIG.apiUrl}${path}`,
        withAuth,
        status: 0,
        statusText: 'Erro de rede',
        durationMs: 0,
        body: { message: err instanceof Error ? err.message : 'Falha na conexão' },
      });
    } finally {
      setTesting(null);
    }
  }

  async function copyJwt() {
    if (!session?.idToken) return;
    await navigator.clipboard.writeText(session.idToken);
    setCopiedToken(true);
    setTimeout(() => setCopiedToken(false), 2000);
  }

  return (
    <ModalDialog
      open={open}
      onClose={onClose}
      title="Inspeção da Arquitetura — Sistemas Distribuídos"
      subtitle="Demonstração ao vivo das 3 camadas, DNS customizado, API REST, Cognito JWT e autorização."
      size="lg"
    >
      <div className="space-y-5">
        {/* 3 Camadas + DNS */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-blue-700">
              <Globe className="h-4 w-4" />
              1. Apresentação
            </div>
            <p className="mt-1.5 text-sm font-semibold text-slate-900">AWS Amplify (React + TS)</p>
            <p className="mt-1 break-all font-mono text-[11px] text-slate-600">
              {window.location.origin}
            </p>
          </div>

          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-teal-700">
              <Server className="h-4 w-4" />
              2. Negócios (REST)
            </div>
            <p className="mt-1.5 text-sm font-semibold text-slate-900">API Gateway + Lambda</p>
            <p className="mt-1 break-all font-mono text-[11px] text-slate-600">
              {COGNITO_CONFIG.apiUrl}
            </p>
          </div>

          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-amber-700">
              <Database className="h-4 w-4" />
              3. Dados
            </div>
            <p className="mt-1.5 text-sm font-semibold text-slate-900">Amazon DynamoDB</p>
            <p className="mt-1 font-mono text-[11px] text-slate-600">
              Partição isolada: USER#sub
            </p>
          </div>
        </div>

        {/* Testes ao vivo de Autorização */}
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <h3 className="text-sm font-semibold text-slate-900">
            Testar API ao vivo (Autorização HTTP)
          </h3>
          <p className="mt-0.5 text-xs text-slate-500">
            Dispara requisições reais para <code className="font-mono">{COGNITO_CONFIG.apiUrl}</code>{' '}
            mostrando o comportamento público, bloqueado (401) e autorizado (200).
          </p>

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={Boolean(testing)}
              onClick={() => runTest('health', '/health', false)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-800 transition hover:bg-slate-100 disabled:opacity-50"
            >
              <Play className="h-3.5 w-3.5 text-slate-600" />
              GET /health (Pública)
            </button>

            <button
              type="button"
              disabled={Boolean(testing)}
              onClick={() => runTest('unauth', '/tasks', false)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-700 transition hover:bg-red-100 disabled:opacity-50"
            >
              <ShieldAlert className="h-3.5 w-3.5" />
              GET /tasks SEM JWT (401)
            </button>

            {session && (
              <button
                type="button"
                disabled={Boolean(testing)}
                onClick={() => runTest('auth', '/me', true)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-800 transition hover:bg-emerald-100 disabled:opacity-50"
              >
                <ShieldCheck className="h-3.5 w-3.5" />
                GET /me COM JWT Cognito (200)
              </button>
            )}
          </div>

          {result && (
            <div className="mt-3 overflow-hidden rounded-lg border border-slate-200 bg-slate-950 text-slate-100">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 px-3 py-2 text-xs">
                <span className="break-all font-mono text-slate-300">GET {result.endpoint}</span>
                <div className="flex items-center gap-2">
                  <span
                    className={`rounded px-2 py-0.5 font-mono font-semibold ${
                      result.status >= 200 && result.status < 300
                        ? 'bg-emerald-500/20 text-emerald-300'
                        : 'bg-red-500/20 text-red-300'
                    }`}
                  >
                    HTTP {result.status} {result.statusText}
                  </span>
                  <span className="font-mono text-slate-400">{result.durationMs} ms</span>
                </div>
              </div>
              <pre className="max-h-56 overflow-auto p-3 font-mono text-xs leading-relaxed text-slate-200">
                {JSON.stringify(result.body, null, 2)}
              </pre>
            </div>
          )}
        </div>

        {/* Claims JWT decodificadas */}
        {session && claims && (
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <KeyRound className="h-4 w-4 text-blue-600" />
                <h3 className="text-sm font-semibold text-slate-900">
                  Token JWT ativo (Amazon Cognito)
                </h3>
              </div>
              <button
                type="button"
                onClick={copyJwt}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 transition hover:bg-slate-100"
              >
                {copiedToken ? (
                  <>
                    <Check className="h-3.5 w-3.5 text-emerald-600" />
                    Token copiado
                  </>
                ) : (
                  <>
                    <Copy className="h-3.5 w-3.5" />
                    Copiar JWT (para Postman)
                  </>
                )}
              </button>
            </div>

            <dl className="mt-3 grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
              <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
                <dt className="text-slate-500">E-mail autenticado</dt>
                <dd className="mt-0.5 truncate font-mono font-medium text-slate-900">
                  {session.email || '—'}
                </dd>
              </div>
              <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
                <dt className="text-slate-500">Identificador único (sub)</dt>
                <dd className="mt-0.5 truncate font-mono font-medium text-slate-900">
                  {session.sub}
                </dd>
              </div>
              <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
                <dt className="text-slate-500">Emissor (iss)</dt>
                <dd className="mt-0.5 truncate font-mono text-[11px] text-slate-700">
                  {String(claims.iss || '—')}
                </dd>
              </div>
              <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
                <dt className="text-slate-500">Expira em</dt>
                <dd className="mt-0.5 font-mono text-slate-900">
                  {new Date(session.expiresAt).toLocaleTimeString('pt-BR')}
                </dd>
              </div>
            </dl>
          </div>
        )}
      </div>
    </ModalDialog>
  );
}
