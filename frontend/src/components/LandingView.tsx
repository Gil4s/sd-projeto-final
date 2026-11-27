import { useState } from 'react';
import {
  ArrowRight,
  CheckCircle2,
  Database,
  Globe,
  Lock,
  Play,
  Server,
  ShieldAlert,
  UserPlus,
} from 'lucide-react';
import { COGNITO_CONFIG, isCognitoConfigured, startCognitoLogin } from '../auth/cognito';
import { apiClient } from '../api/client';
import type { RawTestResult } from '../types';

interface LandingViewProps {
  authError: string | null;
}

export function LandingView({ authError }: LandingViewProps) {
  const [loadingMode, setLoadingMode] = useState<'login' | 'signup' | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [probe, setProbe] = useState<RawTestResult | null>(null);
  const [probing, setProbing] = useState(false);

  const configured = isCognitoConfigured();

  async function handleAuth(mode: 'login' | 'signup') {
    setLocalError(null);
    setLoadingMode(mode);
    try {
      await startCognitoLogin(mode);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Erro ao iniciar login no Cognito.');
      setLoadingMode(null);
    }
  }

  async function runUnauthProbe(path: string) {
    setProbing(true);
    try {
      const res = await apiClient.testRawRequest(path, null);
      setProbe(res);
    } catch (err) {
      setProbe({
        endpoint: `${COGNITO_CONFIG.apiUrl}${path}`,
        withAuth: false,
        status: 0,
        statusText: 'Erro de rede',
        durationMs: 0,
        body: { message: err instanceof Error ? err.message : 'Falha na conexão' },
      });
    } finally {
      setProbing(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-600 text-white shadow-sm">
              <CheckCircle2 className="h-5 w-5" />
            </div>
            <div>
              <span className="text-base font-bold tracking-tight text-slate-900">TaskCloud</span>
              <span className="ml-2 hidden rounded-md bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600 sm:inline-block">
                UFERSA · Sistemas Distribuídos
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={!configured || Boolean(loadingMode)}
              onClick={() => handleAuth('signup')}
              className="rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
            >
              Criar conta
            </button>
            <button
              type="button"
              disabled={!configured || Boolean(loadingMode)}
              onClick={() => handleAuth('login')}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:opacity-50"
            >
              {loadingMode === 'login' ? 'Redirecionando...' : 'Entrar'}
              <ArrowRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-12 sm:px-6 lg:py-16">
        {(authError || localError) && (
          <div className="mb-8 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            {authError || localError}
          </div>
        )}

        {!configured && (
          <div className="mb-8 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <strong>Configuração pendente:</strong> defina as variáveis de ambiente{' '}
            <code className="font-mono">VITE_COGNITO_DOMAIN</code> e{' '}
            <code className="font-mono">VITE_COGNITO_CLIENT_ID</code> no AWS Amplify.
          </div>
        )}

        <div className="grid grid-cols-1 items-start gap-10 lg:grid-cols-12">
          {/* Coluna principal */}
          <div className="lg:col-span-7">
            <div className="inline-flex items-center gap-2 rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-700">
              <Lock className="h-3.5 w-3.5" />
              Projeto Final · Guilherme Aguiar · Grupo 06
            </div>

            <h1 className="mt-4 text-3xl font-extrabold tracking-tight text-slate-900 sm:text-5xl">
              Quadro Kanban de tarefas em arquitetura distribuída na AWS.
            </h1>

            <p className="mt-4 max-w-2xl text-base leading-relaxed text-slate-600 sm:text-lg">
              Crie, edite e mova tarefas entre colunas com persistência no Amazon DynamoDB — com
              login via Amazon Cognito e API REST protegida por token JWT.
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={!configured || Boolean(loadingMode)}
                onClick={() => handleAuth('login')}
                className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-6 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-700 disabled:opacity-50"
              >
                <Lock className="h-4 w-4" />
                {loadingMode === 'login' ? 'Abrindo AWS Cognito...' : 'Entrar com AWS Cognito'}
              </button>

              <button
                type="button"
                disabled={!configured || Boolean(loadingMode)}
                onClick={() => handleAuth('signup')}
                className="inline-flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-800 transition hover:bg-slate-50 disabled:opacity-50"
              >
                <UserPlus className="h-4 w-4" />
                Criar nova conta
              </button>
            </div>

            {/* Cards das 3 camadas */}
            <div className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-xs">
                <Globe className="h-5 w-5 text-blue-600" />
                <h2 className="mt-2.5 text-sm font-bold text-slate-900">1. Apresentação</h2>
                <p className="mt-1 text-xs leading-relaxed text-slate-600">
                  SPA React/TypeScript servida no AWS Amplify com HTTPS pelo Route 53.
                </p>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-xs">
                <Server className="h-5 w-5 text-teal-600" />
                <h2 className="mt-2.5 text-sm font-bold text-slate-900">2. Negócios (REST)</h2>
                <p className="mt-1 text-xs leading-relaxed text-slate-600">
                  API Gateway HTTP + AWS Lambda protegida por autorizador JWT do Cognito.
                </p>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-xs">
                <Database className="h-5 w-5 text-amber-600" />
                <h2 className="mt-2.5 text-sm font-bold text-slate-900">3. Dados</h2>
                <p className="mt-1 text-xs leading-relaxed text-slate-600">
                  Amazon DynamoDB com partição isolada por usuário (PK = USER#sub).
                </p>
              </div>
            </div>
          </div>

          {/* Card interativo para demonstrar 401 vs 200 ainda deslogado */}
          <div className="lg:col-span-5">
            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <h2 className="text-sm font-bold text-slate-900">
                Demonstração ao vivo de autorização da API
              </h2>
              <p className="mt-1 text-xs leading-relaxed text-slate-600">
                Antes mesmo de entrar, valide que a API responde no DNS customizado e bloqueia
                qualquer chamada sem JWT válido do Cognito:
              </p>

              <div className="mt-3 rounded-lg bg-slate-50 px-3 py-2 font-mono text-[11px] text-slate-700">
                <div>App: {window.location.origin}</div>
                <div className="mt-0.5 truncate">API: {COGNITO_CONFIG.apiUrl}</div>
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={probing}
                  onClick={() => runUnauthProbe('/tasks')}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700 transition hover:bg-red-100 disabled:opacity-50"
                >
                  <ShieldAlert className="h-3.5 w-3.5" />
                  Chamar GET /tasks sem token
                </button>
                <button
                  type="button"
                  disabled={probing}
                  onClick={() => runUnauthProbe('/health')}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
                >
                  <Play className="h-3.5 w-3.5" />
                  GET /health (pública)
                </button>
              </div>

              {probe && (
                <div className="mt-4 overflow-hidden rounded-xl border border-slate-200 bg-slate-950 text-slate-100">
                  <div className="flex items-center justify-between border-b border-slate-800 px-3 py-2 text-xs">
                    <span className="truncate font-mono text-slate-400">
                      {probe.endpoint.replace(COGNITO_CONFIG.apiUrl, '')}
                    </span>
                    <span
                      className={`rounded px-2 py-0.5 font-mono font-semibold ${
                        probe.status >= 200 && probe.status < 300
                          ? 'bg-emerald-500/20 text-emerald-300'
                          : 'bg-red-500/20 text-red-300'
                      }`}
                    >
                      HTTP {probe.status} {probe.statusText}
                    </span>
                  </div>
                  <pre className="max-h-52 overflow-auto p-3 font-mono text-[11px] leading-relaxed text-slate-200">
                    {JSON.stringify(probe.body, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
