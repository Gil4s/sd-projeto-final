import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Calendar,
  CheckCircle2,
  Circle,
  Clock,
  FolderKanban,
  GripVertical,
  Layers,
  LayoutGrid,
  List,
  Loader2,
  LogOut,
  Paperclip,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import {
  clearLocalSession,
  getStoredSession,
  handleCognitoCallbackIfPresent,
  logoutCognito,
} from './auth/cognito';
import { ApiError, apiClient } from './api/client';
import { LandingView } from './components/LandingView';
import { ProjectModal } from './components/ProjectModal';
import { TaskModal } from './components/TaskModal';
import { ArchitectureModal } from './components/ArchitectureModal';
import type { AuthSession, Project, Task, TaskPriority, TaskStatus } from './types';

const STATUS_COLUMNS: { key: TaskStatus; label: string; dotClass: string; badgeClass: string }[] = [
  {
    key: 'todo',
    label: 'A fazer',
    dotClass: 'bg-slate-400',
    badgeClass: 'bg-slate-100 text-slate-700',
  },
  {
    key: 'doing',
    label: 'Em andamento',
    dotClass: 'bg-blue-500',
    badgeClass: 'bg-blue-50 text-blue-700',
  },
  {
    key: 'done',
    label: 'Concluído',
    dotClass: 'bg-emerald-500',
    badgeClass: 'bg-emerald-50 text-emerald-700',
  },
];

const PRIORITY_META: Record<TaskPriority, { label: string; badgeClass: string }> = {
  low: { label: 'Baixa', badgeClass: 'bg-slate-100 text-slate-600' },
  medium: { label: 'Média', badgeClass: 'bg-amber-50 text-amber-700 border border-amber-200/70' },
  high: { label: 'Alta', badgeClass: 'bg-red-50 text-red-700 border border-red-200/70' },
};

function formatDateBr(iso: string | null): string | null {
  if (!iso) return null;
  const parts = iso.split('-');
  if (parts.length !== 3) return iso;
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

export default function App() {
  const [booting, setBooting] = useState(true);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loadingData, setLoadingData] = useState(false);

  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [priorityFilter, setPriorityFilter] = useState<TaskPriority | 'all'>('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [viewMode, setViewMode] = useState<'kanban' | 'list'>('kanban');

  const [projectModalOpen, setProjectModalOpen] = useState(false);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [confirmDeleteProjectId, setConfirmDeleteProjectId] = useState<string | null>(null);

  const [taskModalOpen, setTaskModalOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);

  const [archModalOpen, setArchModalOpen] = useState(false);
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [liveAnnouncement, setLiveAnnouncement] = useState('');

  const [dragState, setDragState] = useState<{
    taskId: string;
    taskTitle: string;
    sourceStatus: TaskStatus;
    pointerId: number;
    startX: number;
    startY: number;
    dx: number;
    dy: number;
    overStatus: TaskStatus | null;
  } | null>(null);
  const dragRef = useRef(dragState);
  dragRef.current = dragState;
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;

  const announce = useCallback((message: string) => {
    setLiveAnnouncement('');
    window.setTimeout(() => setLiveAnnouncement(message), 40);
  }, []);

  const showToast = useCallback((text: string, kind: 'ok' | 'err' = 'ok') => {
    setToast({ text, kind });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 3500);
    return () => window.clearTimeout(t);
  }, [toast]);

  // Inicialização da sessão / callback OAuth2 PKCE do Cognito
  useEffect(() => {
    let active = true;
    async function initAuth() {
      try {
        const fromCallback = await handleCognitoCallbackIfPresent();
        if (!active) return;
        if (fromCallback) {
          setSession(fromCallback);
        } else {
          setSession(getStoredSession());
        }
      } catch (err) {
        if (!active) return;
        setAuthError(err instanceof Error ? err.message : 'Erro na autenticação.');
      } finally {
        if (active) setBooting(false);
      }
    }
    initAuth();
    return () => {
      active = false;
    };
  }, []);

  const handleApiError = useCallback(
    (err: unknown, fallback: string) => {
      if (err instanceof ApiError && err.status === 401) {
        clearLocalSession();
        setSession(null);
        setAuthError('Sua sessão expirou ou o token JWT foi recusado (HTTP 401). Entre novamente.');
        return;
      }
      showToast(err instanceof Error ? err.message : fallback, 'err');
    },
    [showToast],
  );

  const loadWorkspace = useCallback(async () => {
    if (!session) return;
    setLoadingData(true);
    try {
      const [projs, allTasks] = await Promise.all([
        apiClient.listProjects(session.idToken),
        apiClient.listTasks(session.idToken),
      ]);
      setProjects(projs);
      setTasks(allTasks);
    } catch (err) {
      handleApiError(err, 'Erro ao carregar dados da API.');
    } finally {
      setLoadingData(false);
    }
  }, [session, handleApiError]);

  useEffect(() => {
    if (session) {
      loadWorkspace();
    }
  }, [session, loadWorkspace]);

  const projectMap = useMemo(() => {
    const map = new Map<string, Project>();
    for (const p of projects) map.set(p.id, p);
    return map;
  }, [projects]);

  const filteredTasks = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    return tasks.filter((t) => {
      if (selectedProjectId && t.projectId !== selectedProjectId) return false;
      if (priorityFilter !== 'all' && t.priority !== priorityFilter) return false;
      if (q) {
        const hay = `${t.title} ${t.description}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [tasks, selectedProjectId, priorityFilter, searchTerm]);

  const stats = useMemo(() => {
    const total = tasks.length;
    const done = tasks.filter((t) => t.status === 'done').length;
    const attachments = tasks.reduce((acc, t) => acc + (t.attachments?.length || 0), 0);
    return { total, done, attachments };
  }, [tasks]);

  const activeProject = selectedProjectId ? projectMap.get(selectedProjectId) || null : null;

  // ---------------- AÇÕES DE PROJETO ----------------
  async function handleSaveProject(payload: { name: string; description: string; color: string }) {
    if (!session) return;
    if (editingProject) {
      const updated = await apiClient.updateProject(session.idToken, editingProject.id, payload);
      setProjects((prev) => prev.map((p) => (p.id === updated.id ? { ...p, ...updated } : p)));
      showToast('Projeto atualizado.');
    } else {
      const created = await apiClient.createProject(session.idToken, payload);
      setProjects((prev) => [created, ...prev]);
      setSelectedProjectId(created.id);
      showToast('Projeto criado no DynamoDB.');
    }
  }

  async function handleDeleteProject(projectId: string) {
    if (!session) return;
    try {
      await apiClient.deleteProject(session.idToken, projectId);
      setProjects((prev) => prev.filter((p) => p.id !== projectId));
      setTasks((prev) => prev.filter((t) => t.projectId !== projectId));
      if (selectedProjectId === projectId) setSelectedProjectId(null);
      setConfirmDeleteProjectId(null);
      showToast('Projeto e tarefas associadas excluídos.');
    } catch (err) {
      handleApiError(err, 'Erro ao excluir projeto.');
    }
  }

  // ---------------- AÇÕES DE TAREFA ----------------
  async function handleSaveTask(payload: {
    title: string;
    description: string;
    status: TaskStatus;
    priority: TaskPriority;
    dueDate: string | null;
    projectId: string | null;
  }): Promise<Task> {
    if (!session) throw new Error('Sessão inválida');
    if (editingTask) {
      const updated = await apiClient.updateTask(session.idToken, editingTask.id, payload);
      setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
      showToast('Tarefa atualizada.');
      return updated;
    }
    const created = await apiClient.createTask(session.idToken, payload);
    setTasks((prev) => [created, ...prev]);
    showToast('Tarefa criada no DynamoDB.');
    return created;
  }

  const handleQuickStatusChange = useCallback(
    async (task: Task, nextStatus: TaskStatus) => {
      if (!session || task.status === nextStatus) return;
      const colLabel =
        STATUS_COLUMNS.find((c) => c.key === nextStatus)?.label || nextStatus;
      const prevTasks = tasksRef.current;
      setTasks((curr) => curr.map((t) => (t.id === task.id ? { ...t, status: nextStatus } : t)));
      announce(`Tarefa ${task.title} movida para ${colLabel}.`);
      try {
        const updated = await apiClient.updateTask(session.idToken, task.id, {
          status: nextStatus,
        });
        setTasks((curr) => curr.map((t) => (t.id === updated.id ? updated : t)));
        showToast(`"${task.title}" movida para ${colLabel}.`);
      } catch (err) {
        setTasks(prevTasks);
        handleApiError(err, 'Não foi possível atualizar o status.');
      }
    },
    [session, announce, showToast, handleApiError],
  );

  const finishDrag = useCallback((cancelReason?: string) => {
    document.documentElement.classList.remove('is-dragging-card');
    setDragState(null);
    if (cancelReason) {
      announce(cancelReason);
    }
  }, [announce]);

  function startCardDrag(e: React.PointerEvent<HTMLButtonElement>, task: Task) {
    if (e.button !== 0 || dragRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    document.documentElement.classList.add('is-dragging-card');
    setDragState({
      taskId: task.id,
      taskTitle: task.title,
      sourceStatus: task.status,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      dx: 0,
      dy: 0,
      overStatus: task.status,
    });
  }

  useEffect(() => {
    if (!dragState) return;

    const findColumnAt = (x: number, y: number): TaskStatus | null => {
      const el = document.elementFromPoint(x, y);
      const col = el?.closest<HTMLElement>('[data-kanban-column]')?.dataset.kanbanColumn;
      if (col === 'todo' || col === 'doing' || col === 'done') return col;
      return null;
    };

    const onPointerMove = (e: PointerEvent) => {
      const curr = dragRef.current;
      if (!curr || e.pointerId !== curr.pointerId) return;
      const dx = e.clientX - curr.startX;
      const dy = e.clientY - curr.startY;
      const overStatus = findColumnAt(e.clientX, e.clientY);
      setDragState((prev) => (prev ? { ...prev, dx, dy, overStatus } : null));
    };

    const onPointerUp = (e: PointerEvent) => {
      const curr = dragRef.current;
      if (!curr || e.pointerId !== curr.pointerId) return;
      const targetStatus = findColumnAt(e.clientX, e.clientY) || curr.overStatus;
      const draggedTask = tasksRef.current.find((t) => t.id === curr.taskId);
      finishDrag();
      if (draggedTask && targetStatus && targetStatus !== curr.sourceStatus) {
        void handleQuickStatusChange(draggedTask, targetStatus);
      }
    };

    const onPointerCancel = (e: PointerEvent) => {
      const curr = dragRef.current;
      if (!curr || e.pointerId !== curr.pointerId) return;
      finishDrag('Movimentação cancelada.');
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dragRef.current) {
        e.preventDefault();
        finishDrag('Movimentação cancelada.');
      }
    };

    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('pointercancel', onPointerCancel);
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
      document.removeEventListener('pointercancel', onPointerCancel);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [Boolean(dragState), finishDrag, handleQuickStatusChange]);

  async function handleDeleteTask(taskId: string) {
    if (!session) return;
    await apiClient.deleteTask(session.idToken, taskId);
    setTasks((prev) => prev.filter((t) => t.id !== taskId));
    showToast('Tarefa excluída.');
  }

  // ---------------- AÇÕES DE ANEXO S3 ----------------
  async function handleUploadAttachment(taskId: string, file: File) {
    if (!session) throw new Error('Sessão inválida');
    const { uploadUrl, attachment } = await apiClient.requestUploadUrl(session.idToken, taskId, {
      filename: file.name,
      contentType: file.type || 'application/octet-stream',
      size: file.size,
    });
    await apiClient.uploadFileDirectToS3(uploadUrl, file);
    setTasks((prev) =>
      prev.map((t) =>
        t.id === taskId ? { ...t, attachments: [...(t.attachments || []), attachment] } : t,
      ),
    );
    showToast(`Anexo "${file.name}" salvo no S3 privado.`);
    return attachment;
  }

  async function handleOpenAttachment(taskId: string, attachmentId: string) {
    if (!session) return;
    const { downloadUrl } = await apiClient.requestDownloadUrl(
      session.idToken,
      taskId,
      attachmentId,
    );
    window.open(downloadUrl, '_blank', 'noopener,noreferrer');
  }

  async function handleDeleteAttachment(taskId: string, attachmentId: string) {
    if (!session) return;
    await apiClient.deleteAttachment(session.idToken, taskId, attachmentId);
    setTasks((prev) =>
      prev.map((t) =>
        t.id === taskId
          ? { ...t, attachments: (t.attachments || []).filter((a) => a.id !== attachmentId) }
          : t,
      ),
    );
    showToast('Anexo removido do S3.');
  }

  if (booting) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-slate-50 text-slate-600">
        <Loader2 className="h-7 w-7 animate-spin text-blue-600" />
        <p className="text-sm font-medium">Validando sessão no Amazon Cognito...</p>
      </div>
    );
  }

  if (!session) {
    return <LandingView authError={authError} />;
  }

  return (
    <div className="flex min-h-screen flex-col bg-slate-50 text-slate-900">
      {/* Barra superior */}
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur-sm">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600 text-white">
              <CheckCircle2 className="h-4 w-4" />
            </div>
            <div>
              <span className="text-sm font-bold tracking-tight text-slate-900">TaskCloud</span>
              <span className="ml-2 hidden font-mono text-[11px] text-slate-500 md:inline">
                guilhermeag.grupo-06.sd.ufersa.dev.br
              </span>
            </div>
          </div>

          <div className="relative order-3 w-full sm:order-2 sm:w-72 md:w-80">
            <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              type="search"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Buscar tarefas..."
              aria-label="Buscar tarefas"
              className="w-full rounded-lg border border-slate-200 bg-slate-50 py-1.5 pr-3 pl-9 text-sm text-slate-900 outline-none transition focus:border-blue-600 focus:bg-white focus:ring-2 focus:ring-blue-600/20"
            />
          </div>

          <div className="order-2 flex items-center gap-2 sm:order-3">
            <button
              type="button"
              onClick={() => setArchModalOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-semibold text-blue-700 transition hover:bg-blue-100"
            >
              <ShieldCheck className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Demo SD / JWT</span>
            </button>

            <div className="hidden items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs text-slate-700 lg:flex">
              <span className="h-2 w-2 rounded-full bg-emerald-500" />
              <span className="max-w-44 truncate font-medium">{session.email || session.username}</span>
            </div>

            <button
              type="button"
              onClick={logoutCognito}
              aria-label="Sair da conta"
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-100"
            >
              <LogOut className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Sair</span>
            </button>
          </div>
        </div>
      </header>

      {/* Corpo principal */}
      <div className="mx-auto flex w-full max-w-[1440px] flex-1 flex-col gap-6 px-4 py-6 sm:px-6 lg:flex-row">
        {/* Sidebar esquerda: Projetos e Métricas */}
        <aside className="w-full shrink-0 space-y-5 lg:w-64">
          {/* Contadores rápidos */}
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-xl border border-slate-200 bg-white p-3 text-center">
              <p className="text-lg font-bold text-slate-900">{stats.total}</p>
              <p className="text-[11px] font-medium text-slate-500">Tarefas</p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-3 text-center">
              <p className="text-lg font-bold text-emerald-600">{stats.done}</p>
              <p className="text-[11px] font-medium text-slate-500">Feitas</p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-3 text-center">
              <p className="text-lg font-bold text-blue-600">{stats.attachments}</p>
              <p className="text-[11px] font-medium text-slate-500">Anexos S3</p>
            </div>
          </div>

          {/* Lista de Projetos */}
          <div className="rounded-2xl border border-slate-200 bg-white p-3">
            <div className="mb-2 flex items-center justify-between px-2">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-500">
                Projetos
              </span>
              <button
                type="button"
                onClick={() => {
                  setEditingProject(null);
                  setProjectModalOpen(true);
                }}
                aria-label="Criar novo projeto"
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold text-blue-600 transition hover:bg-blue-50"
              >
                <Plus className="h-3.5 w-3.5" />
                Novo
              </button>
            </div>

            <nav className="space-y-1">
              <button
                type="button"
                onClick={() => setSelectedProjectId(null)}
                className={`flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-sm font-medium transition ${
                  selectedProjectId === null
                    ? 'bg-blue-50 text-blue-700'
                    : 'text-slate-700 hover:bg-slate-50'
                }`}
              >
                <span className="flex items-center gap-2">
                  <Layers className="h-4 w-4" />
                  Todas as tarefas
                </span>
                <span className="rounded-full bg-white px-2 py-0.5 text-xs font-semibold text-slate-600 shadow-2xs">
                  {tasks.length}
                </span>
              </button>

              {projects.map((proj) => {
                const projTasks = tasks.filter((t) => t.projectId === proj.id);
                const selected = selectedProjectId === proj.id;
                const confirming = confirmDeleteProjectId === proj.id;

                return (
                  <div
                    key={proj.id}
                    className={`group rounded-lg transition ${
                      selected ? 'bg-blue-50/90' : 'hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1 px-2.5 py-2">
                      <button
                        type="button"
                        onClick={() => setSelectedProjectId(proj.id)}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm font-medium text-slate-800"
                      >
                        <span
                          className="h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: proj.color }}
                        />
                        <span className={`truncate ${selected ? 'text-blue-700' : ''}`}>
                          {proj.name}
                        </span>
                      </button>

                      <div className="flex shrink-0 items-center gap-0.5">
                        <span className="mr-1 text-xs text-slate-400">{projTasks.length}</span>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingProject(proj);
                            setProjectModalOpen(true);
                          }}
                          aria-label={`Editar projeto ${proj.name}`}
                          className="rounded p-1 text-slate-400 opacity-70 transition hover:bg-white hover:text-slate-700 group-hover:opacity-100"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setConfirmDeleteProjectId(confirming ? null : proj.id)
                          }
                          aria-label={`Excluir projeto ${proj.name}`}
                          className="rounded p-1 text-slate-400 opacity-70 transition hover:bg-red-50 hover:text-red-600 group-hover:opacity-100"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>

                    {confirming && (
                      <div className="flex items-center justify-between border-t border-red-100 bg-red-50/80 px-2.5 py-1.5 text-xs">
                        <span className="font-medium text-red-700">Apagar projeto?</span>
                        <div className="flex gap-1.5">
                          <button
                            type="button"
                            onClick={() => handleDeleteProject(proj.id)}
                            className="rounded bg-red-600 px-2 py-0.5 font-semibold text-white hover:bg-red-700"
                          >
                            Sim
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteProjectId(null)}
                            className="rounded bg-white px-2 py-0.5 font-medium text-slate-600 hover:bg-slate-100"
                          >
                            Não
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}

              {projects.length === 0 && !loadingData && (
                <p className="px-2.5 py-3 text-xs text-slate-500">
                  Nenhum projeto ainda. Crie um para agrupar suas tarefas.
                </p>
              )}
            </nav>
          </div>
        </aside>

        {/* Área principal */}
        <main className="min-w-0 flex-1 space-y-5">
          {/* Cabeçalho da visão ativa */}
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                {activeProject ? (
                  <span
                    className="h-3 w-3 rounded-full"
                    style={{ backgroundColor: activeProject.color }}
                  />
                ) : (
                  <FolderKanban className="h-5 w-5 text-blue-600" />
                )}
                <h1 className="text-xl font-bold tracking-tight text-slate-900 sm:text-2xl">
                  {activeProject ? activeProject.name : 'Todas as tarefas'}
                </h1>
              </div>
              <p className="mt-0.5 text-sm text-slate-500">
                {activeProject?.description ||
                  'Gerencie entregas, mude status e anexe arquivos diretamente no S3 privado.'}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={loadWorkspace}
                disabled={loadingData}
                aria-label="Atualizar dados da API"
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${loadingData ? 'animate-spin' : ''}`} />
                Atualizar
              </button>

              <div className="flex rounded-lg border border-slate-200 bg-white p-0.5">
                <button
                  type="button"
                  onClick={() => setViewMode('kanban')}
                  aria-pressed={viewMode === 'kanban'}
                  className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-semibold transition ${
                    viewMode === 'kanban'
                      ? 'bg-slate-900 text-white'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  <LayoutGrid className="h-3.5 w-3.5" />
                  Kanban
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode('list')}
                  aria-pressed={viewMode === 'list'}
                  className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-semibold transition ${
                    viewMode === 'list'
                      ? 'bg-slate-900 text-white'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  <List className="h-3.5 w-3.5" />
                  Lista
                </button>
              </div>

              <button
                type="button"
                onClick={() => {
                  setEditingTask(null);
                  setTaskModalOpen(true);
                }}
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-xs transition hover:bg-blue-700"
              >
                <Plus className="h-4 w-4" />
                Nova tarefa
              </button>
            </div>
          </div>

          {/* Filtros de prioridade */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-slate-500">Prioridade:</span>
            {(['all', 'high', 'medium', 'low'] as const).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPriorityFilter(p)}
                className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
                  priorityFilter === p
                    ? 'bg-slate-900 text-white'
                    : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-100'
                }`}
              >
                {p === 'all' ? 'Todas' : PRIORITY_META[p].label}
              </button>
            ))}
          </div>

          {/* Conteúdo: Loading / Empty / Kanban / Lista */}
          {loadingData && tasks.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-white py-16 text-slate-500">
              <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
              <p className="mt-2 text-sm">Carregando tarefas do DynamoDB...</p>
            </div>
          ) : viewMode === 'kanban' ? (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              {STATUS_COLUMNS.map((col) => {
                const colTasks = filteredTasks.filter((t) => t.status === col.key);
                const isDropTarget =
                  dragState !== null &&
                  dragState.overStatus === col.key &&
                  dragState.sourceStatus !== col.key;

                return (
                  <section
                    key={col.key}
                    data-kanban-column={col.key}
                    className={`flex min-h-48 flex-col rounded-2xl border p-3 transition-colors ${
                      isDropTarget
                        ? 'border-blue-400 bg-blue-50/70 ring-2 ring-blue-500/25'
                        : 'border-slate-200 bg-slate-100/70'
                    }`}
                  >
                    <div className="mb-3 flex items-center justify-between px-1">
                      <div className="flex items-center gap-2">
                        <span className={`h-2.5 w-2.5 rounded-full ${col.dotClass}`} />
                        <h2 className="text-sm font-bold text-slate-800">{col.label}</h2>
                      </div>
                      <span className="rounded-full bg-white px-2 py-0.5 text-xs font-semibold text-slate-600 shadow-2xs">
                        {colTasks.length}
                      </span>
                    </div>

                    <div className="flex flex-1 flex-col gap-2.5">
                      {colTasks.map((task) => {
                        const proj = task.projectId ? projectMap.get(task.projectId) : null;
                        const dueFormatted = formatDateBr(task.dueDate);
                        const isDragging = dragState?.taskId === task.id;

                        return (
                          <article
                            key={task.id}
                            style={
                              isDragging
                                ? { translate: `${dragState.dx}px ${dragState.dy}px` }
                                : undefined
                            }
                            className={`group rounded-xl border border-slate-200 bg-white p-3.5 shadow-2xs transition-[border-color,box-shadow] hover:border-blue-300 hover:shadow-sm ${
                              isDragging ? 'kanban-card-dragging' : ''
                            }`}
                          >
                            {/* Barra de arraste estilo Trello (alça dedicada com Pointer Events) */}
                            <div className="mb-2 flex items-center justify-between gap-2">
                              <button
                                type="button"
                                onPointerDown={(e) => startCardDrag(e, task)}
                                onLostPointerCapture={() => {
                                  if (dragRef.current?.taskId === task.id) {
                                    finishDrag();
                                  }
                                }}
                                aria-label={`Arrastar tarefa ${task.title} para outra coluna`}
                                title="Arraste para mover de coluna (Esc cancela)"
                                className="drag-handle -ml-1 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 focus-visible:bg-slate-100 focus-visible:text-slate-700"
                              >
                                <GripVertical className="h-3.5 w-3.5" />
                                <span>Arrastar</span>
                              </button>
                              <span
                                className={`shrink-0 rounded-md px-2 py-0.5 text-[11px] font-semibold ${PRIORITY_META[task.priority].badgeClass}`}
                              >
                                {PRIORITY_META[task.priority].label}
                              </span>
                            </div>

                            <button
                              type="button"
                              onClick={() => {
                                setEditingTask(task);
                                setTaskModalOpen(true);
                              }}
                              className="w-full text-left"
                            >
                              <h3 className="text-sm font-semibold text-slate-900 group-hover:text-blue-700">
                                {task.title}
                              </h3>

                              {task.description && (
                                <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-slate-600">
                                  {task.description}
                                </p>
                              )}

                              <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
                                {proj && (
                                  <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-2 py-0.5 font-medium text-slate-700">
                                    <span
                                      className="h-2 w-2 rounded-full"
                                      style={{ backgroundColor: proj.color }}
                                    />
                                    {proj.name}
                                  </span>
                                )}
                                {dueFormatted && (
                                  <span className="inline-flex items-center gap-1">
                                    <Calendar className="h-3 w-3" />
                                    {dueFormatted}
                                  </span>
                                )}
                                {(task.attachments?.length || 0) > 0 && (
                                  <span className="inline-flex items-center gap-1 rounded-md bg-blue-50 px-1.5 py-0.5 font-semibold text-blue-700">
                                    <Paperclip className="h-3 w-3" />
                                    {task.attachments.length}
                                  </span>
                                )}
                              </div>
                            </button>

                            {/* Ações rápidas de troca de status (acessível por teclado e 1 clique) */}
                            <div className="mt-3 flex items-center justify-end gap-1.5 border-t border-slate-100 pt-2.5 text-[11px]">
                              {task.status !== 'todo' && (
                                <button
                                  type="button"
                                  onClick={() => handleQuickStatusChange(task, 'todo')}
                                  className="rounded-md px-2 py-1 font-medium text-slate-600 transition hover:bg-slate-100"
                                >
                                  A fazer
                                </button>
                              )}
                              {task.status !== 'doing' && (
                                <button
                                  type="button"
                                  onClick={() => handleQuickStatusChange(task, 'doing')}
                                  className="rounded-md bg-blue-50 px-2 py-1 font-semibold text-blue-700 transition hover:bg-blue-100"
                                >
                                  Em andamento
                                </button>
                              )}
                              {task.status !== 'done' && (
                                <button
                                  type="button"
                                  onClick={() => handleQuickStatusChange(task, 'done')}
                                  className="rounded-md bg-emerald-50 px-2 py-1 font-semibold text-emerald-700 transition hover:bg-emerald-100"
                                >
                                  Concluir
                                </button>
                              )}
                            </div>
                          </article>
                        );
                      })}

                      {isDropTarget && (
                        <div className="rounded-xl border-2 border-dashed border-blue-400 bg-blue-50/80 px-3 py-5 text-center text-xs font-semibold text-blue-700">
                          Soltar em &ldquo;{col.label}&rdquo;
                        </div>
                      )}

                      {colTasks.length === 0 && !isDropTarget && (
                        <div className="rounded-xl border border-dashed border-slate-300/80 px-3 py-8 text-center text-xs text-slate-400">
                          Arraste um card para cá ou crie uma tarefa
                        </div>
                      )}
                    </div>
                  </section>
                );
              })}
            </div>
          ) : (
            <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
              {filteredTasks.length === 0 ? (
                <div className="py-16 text-center text-sm text-slate-500">
                  Nenhuma tarefa encontrada com os filtros atuais.
                </div>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {filteredTasks.map((task) => {
                    const proj = task.projectId ? projectMap.get(task.projectId) : null;
                    const dueFormatted = formatDateBr(task.dueDate);
                    const StatusIcon =
                      task.status === 'done'
                        ? CheckCircle2
                        : task.status === 'doing'
                          ? Clock
                          : Circle;
                    const iconColor =
                      task.status === 'done'
                        ? 'text-emerald-600'
                        : task.status === 'doing'
                          ? 'text-blue-600'
                          : 'text-slate-400';

                    return (
                      <li
                        key={task.id}
                        className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5 transition hover:bg-slate-50"
                      >
                        <div className="flex min-w-0 flex-1 items-center gap-3">
                          <button
                            type="button"
                            onClick={() =>
                              handleQuickStatusChange(
                                task,
                                task.status === 'done' ? 'todo' : 'done',
                              )
                            }
                            aria-label={
                              task.status === 'done'
                                ? `Reabrir tarefa ${task.title}`
                                : `Concluir tarefa ${task.title}`
                            }
                            className={`shrink-0 ${iconColor} transition hover:scale-110`}
                          >
                            <StatusIcon className="h-5 w-5" />
                          </button>

                          <button
                            type="button"
                            onClick={() => {
                              setEditingTask(task);
                              setTaskModalOpen(true);
                            }}
                            className="min-w-0 flex-1 text-left"
                          >
                            <p
                              className={`truncate text-sm font-semibold ${
                                task.status === 'done'
                                  ? 'text-slate-400 line-through'
                                  : 'text-slate-900'
                              }`}
                            >
                              {task.title}
                            </p>
                            {task.description && (
                              <p className="truncate text-xs text-slate-500">{task.description}</p>
                            )}
                          </button>
                        </div>

                        <div className="flex flex-wrap items-center gap-2 text-xs">
                          {proj && (
                            <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-2 py-0.5 font-medium text-slate-700">
                              <span
                                className="h-2 w-2 rounded-full"
                                style={{ backgroundColor: proj.color }}
                              />
                              {proj.name}
                            </span>
                          )}
                          <span
                            className={`rounded-md px-2 py-0.5 font-semibold ${PRIORITY_META[task.priority].badgeClass}`}
                          >
                            {PRIORITY_META[task.priority].label}
                          </span>
                          {dueFormatted && (
                            <span className="inline-flex items-center gap-1 text-slate-500">
                              <Calendar className="h-3.5 w-3.5" />
                              {dueFormatted}
                            </span>
                          )}
                          {(task.attachments?.length || 0) > 0 && (
                            <span className="inline-flex items-center gap-1 rounded-md bg-blue-50 px-2 py-0.5 font-semibold text-blue-700">
                              <Paperclip className="h-3.5 w-3.5" />
                              {task.attachments.length}
                            </span>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </main>
      </div>

      {/* Rodapé discreto */}
      <footer className="border-t border-slate-200 bg-white py-3 text-center text-xs text-slate-500">
        UFERSA · Sistemas Distribuídos (Projeto Final) · Guilherme Aguiar (Grupo 06) ·{' '}
        <span className="font-mono">guilhermeag.grupo-06.sd.ufersa.dev.br</span>
      </footer>

      {/* Modais nativos <dialog> */}
      <ProjectModal
        open={projectModalOpen}
        project={editingProject}
        onClose={() => setProjectModalOpen(false)}
        onSave={handleSaveProject}
      />

      <TaskModal
        open={taskModalOpen}
        task={editingTask}
        projects={projects}
        defaultProjectId={selectedProjectId}
        onClose={() => setTaskModalOpen(false)}
        onSave={handleSaveTask}
        onDelete={handleDeleteTask}
        onUploadAttachment={handleUploadAttachment}
        onOpenAttachment={handleOpenAttachment}
        onDeleteAttachment={handleDeleteAttachment}
      />

      <ArchitectureModal
        open={archModalOpen}
        onClose={() => setArchModalOpen(false)}
        session={session}
      />

      {/* Região viva acessível para anúncios de movimentação */}
      <div aria-live="polite" className="visually-hidden">
        {liveAnnouncement}
      </div>

      {/* Toast de feedback */}
      {toast && (
        <div
          role="status"
          aria-live="polite"
          className={`fixed right-4 bottom-4 z-50 rounded-xl px-4 py-2.5 text-sm font-medium shadow-lg ${
            toast.kind === 'err' ? 'bg-red-600 text-white' : 'bg-slate-900 text-white'
          }`}
        >
          {toast.text}
        </div>
      )}
    </div>
  );
}
