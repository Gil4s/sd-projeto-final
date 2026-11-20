import { useEffect, useId, useRef, useState } from 'react';
import { Download, FileText, Loader2, Paperclip, Trash2, Upload } from 'lucide-react';
import { ModalDialog } from './ModalDialog';
import { useFormValidationSync } from '../hooks/useFormValidationSync';
import type { Project, Task, TaskAttachment, TaskPriority, TaskStatus } from '../types';

interface TaskModalProps {
  open: boolean;
  task: Task | null;
  projects: Project[];
  defaultProjectId: string | null;
  onClose: () => void;
  onSave: (payload: {
    title: string;
    description: string;
    status: TaskStatus;
    priority: TaskPriority;
    dueDate: string | null;
    projectId: string | null;
  }) => Promise<Task>;
  onDelete?: (taskId: string) => Promise<void>;
  onUploadAttachment: (taskId: string, file: File) => Promise<TaskAttachment>;
  onOpenAttachment: (taskId: string, attachmentId: string) => Promise<void>;
  onDeleteAttachment: (taskId: string, attachmentId: string) => Promise<void>;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function TaskModal({
  open,
  task,
  projects,
  defaultProjectId,
  onClose,
  onSave,
  onDelete,
  onUploadAttachment,
  onOpenAttachment,
  onDeleteAttachment,
}: TaskModalProps) {
  const formRef = useRef<HTMLFormElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const titleErrId = useId();
  const descId = useId();
  const projectIdField = useId();
  const statusId = useId();
  const priorityId = useId();
  const dueDateId = useId();

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<TaskStatus>('todo');
  const [priority, setPriority] = useState<TaskPriority>('medium');
  const [dueDate, setDueDate] = useState('');
  const [projectId, setProjectId] = useState('');
  const [attachments, setAttachments] = useState<TaskAttachment[]>([]);
  const [pendingFile, setPendingFile] = useState<File | null>(null);

  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [busyAttId, setBusyAttId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useFormValidationSync(formRef, open);

  useEffect(() => {
    if (!open) return;
    setTitle(task?.title || '');
    setDescription(task?.description || '');
    setStatus(task?.status || 'todo');
    setPriority(task?.priority || 'medium');
    setDueDate(task?.dueDate || '');
    setProjectId(task?.projectId || defaultProjectId || '');
    setAttachments(task?.attachments || []);
    setPendingFile(null);
    setConfirmDelete(false);
    setError(null);
  }, [open, task, defaultProjectId]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!formRef.current?.reportValidity()) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await onSave({
        title: title.trim(),
        description: description.trim(),
        status,
        priority,
        dueDate: dueDate || null,
        projectId: projectId || null,
      });
      if (pendingFile) {
        setUploading(true);
        await onUploadAttachment(saved.id, pendingFile);
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao salvar tarefa.');
    } finally {
      setSaving(false);
      setUploading(false);
    }
  }

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    if (file.size > 10 * 1024 * 1024) {
      setError('O arquivo selecionado ultrapassa o limite de 10 MB.');
      return;
    }

    setError(null);
    if (!task) {
      setPendingFile(file);
      return;
    }

    setUploading(true);
    try {
      const added = await onUploadAttachment(task.id, file);
      setAttachments((prev) => [...prev, added]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao enviar anexo para o S3.');
    } finally {
      setUploading(false);
    }
  }

  async function handleOpen(att: TaskAttachment) {
    if (!task) return;
    setBusyAttId(att.id);
    setError(null);
    try {
      await onOpenAttachment(task.id, att.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível gerar link de download.');
    } finally {
      setBusyAttId(null);
    }
  }

  async function handleRemoveAttachment(att: TaskAttachment) {
    if (!task) return;
    setBusyAttId(att.id);
    setError(null);
    try {
      await onDeleteAttachment(task.id, att.id);
      setAttachments((prev) => prev.filter((item) => item.id !== att.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível remover o anexo.');
    } finally {
      setBusyAttId(null);
    }
  }

  async function handleDeleteTask() {
    if (!task || !onDelete) return;
    setSaving(true);
    setError(null);
    try {
      await onDelete(task.id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao excluir tarefa.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalDialog
      open={open}
      onClose={onClose}
      title={task ? 'Detalhes da tarefa' : 'Nova tarefa'}
      subtitle={
        task
          ? 'Atualize os dados no DynamoDB ou anexe arquivos diretamente no bucket S3 privado.'
          : 'Crie uma tarefa persistida no DynamoDB (você já pode anexar um arquivo S3).'
      }
      size="lg"
    >
      <form ref={formRef} onSubmit={handleSubmit} className="space-y-4">
        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-700">
            {error}
          </div>
        )}

        <div>
          <label htmlFor={titleId} className="block text-sm font-medium text-slate-700">
            Título da tarefa *
          </label>
          <span className="mt-0.5 block text-xs text-slate-500">
            Entre 2 e 120 caracteres.
          </span>
          <input
            id={titleId}
            type="text"
            required
            minLength={2}
            maxLength={120}
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            data-error={titleErrId}
            placeholder="Ex.: Validar URL pré-assinada no S3"
            className="field-input mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-blue-600 focus:ring-2 focus:ring-blue-600/20"
          />
          <div id={titleErrId} className="field-error">
            Erro: informe um título com pelo menos 2 caracteres.
          </div>
        </div>

        <div>
          <label htmlFor={descId} className="block text-sm font-medium text-slate-700">
            Descrição
          </label>
          <textarea
            id={descId}
            rows={3}
            maxLength={1500}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Critérios de aceite, anotações técnicas ou observações..."
            className="field-input mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-blue-600 focus:ring-2 focus:ring-blue-600/20"
          />
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor={projectIdField} className="block text-sm font-medium text-slate-700">
              Projeto
            </label>
            <select
              id={projectIdField}
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-blue-600 focus:ring-2 focus:ring-blue-600/20"
            >
              <option value="">Sem projeto</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor={dueDateId} className="block text-sm font-medium text-slate-700">
              Data de entrega
            </label>
            <input
              id={dueDateId}
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-blue-600 focus:ring-2 focus:ring-blue-600/20"
            />
          </div>

          <div>
            <label htmlFor={statusId} className="block text-sm font-medium text-slate-700">
              Status
            </label>
            <select
              id={statusId}
              value={status}
              onChange={(e) => setStatus(e.target.value as TaskStatus)}
              className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-blue-600 focus:ring-2 focus:ring-blue-600/20"
            >
              <option value="todo">A fazer</option>
              <option value="doing">Em andamento</option>
              <option value="done">Concluído</option>
            </select>
          </div>

          <div>
            <label htmlFor={priorityId} className="block text-sm font-medium text-slate-700">
              Prioridade
            </label>
            <select
              id={priorityId}
              value={priority}
              onChange={(e) => setPriority(e.target.value as TaskPriority)}
              className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-blue-600 focus:ring-2 focus:ring-blue-600/20"
            >
              <option value="low">Baixa</option>
              <option value="medium">Média</option>
              <option value="high">Alta</option>
            </select>
          </div>
        </div>

        {/* Seção de Anexos no Amazon S3 Privado */}
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Paperclip className="h-4 w-4 text-slate-600" />
              <span className="text-sm font-semibold text-slate-800">
                Anexos (Amazon S3 Privado)
              </span>
              <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-medium text-slate-700">
                {attachments.length + (pendingFile ? 1 : 0)}
              </span>
            </div>

            <input
              ref={fileInputRef}
              type="file"
              onChange={handleFileSelect}
              className="hidden"
            />
            <button
              type="button"
              disabled={uploading}
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-100 disabled:opacity-60"
            >
              {uploading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Upload className="h-3.5 w-3.5" />
              )}
              {uploading ? 'Enviando para S3...' : 'Anexar arquivo (até 10 MB)'}
            </button>
          </div>

          <p className="mt-1.5 text-xs text-slate-500">
            Upload direto para o S3 via Presigned URL (PUT) e leitura temporária autenticada (GET).
          </p>

          {pendingFile && !task && (
            <div className="mt-3 flex items-center justify-between rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900">
              <div className="flex items-center gap-2 truncate">
                <FileText className="h-4 w-4 shrink-0 text-blue-600" />
                <span className="truncate font-medium">{pendingFile.name}</span>
                <span className="text-blue-600">({formatBytes(pendingFile.size)})</span>
              </div>
              <button
                type="button"
                onClick={() => setPendingFile(null)}
                className="ml-2 font-medium text-blue-700 hover:underline"
              >
                Remover
              </button>
            </div>
          )}

          {attachments.length > 0 && (
            <ul className="mt-3 space-y-2">
              {attachments.map((att) => (
                <li
                  key={att.id}
                  className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <FileText className="h-4 w-4 shrink-0 text-blue-600" />
                    <div className="min-w-0">
                      <p className="truncate font-medium text-slate-800">{att.filename}</p>
                      <p className="text-[11px] text-slate-500">{formatBytes(att.size)}</p>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      type="button"
                      disabled={busyAttId === att.id}
                      onClick={() => handleOpen(att)}
                      className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2.5 py-1 font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
                    >
                      {busyAttId === att.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Download className="h-3.5 w-3.5" />
                      )}
                      Abrir
                    </button>
                    <button
                      type="button"
                      disabled={busyAttId === att.id}
                      onClick={() => handleRemoveAttachment(att)}
                      aria-label={`Remover anexo ${att.filename}`}
                      className="rounded-md p-1.5 text-slate-400 transition hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
          <div>
            {task && onDelete && !confirmDelete && (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-red-600 transition hover:bg-red-50"
              >
                <Trash2 className="h-4 w-4" />
                Excluir tarefa
              </button>
            )}
            {task && onDelete && confirmDelete && (
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-red-700">Confirmar exclusão?</span>
                <button
                  type="button"
                  disabled={saving}
                  onClick={handleDeleteTask}
                  className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700"
                >
                  Sim, excluir
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                  Não
                </button>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={saving || uploading}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:opacity-60"
            >
              {saving ? 'Salvando...' : task ? 'Salvar alterações' : 'Criar tarefa'}
            </button>
          </div>
        </div>
      </form>
    </ModalDialog>
  );
}
