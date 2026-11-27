import { useEffect, useId, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { ModalDialog } from './ModalDialog';
import { useFormValidationSync } from '../hooks/useFormValidationSync';
import type { Task, TaskPriority, TaskStatus } from '../types';

interface TaskModalProps {
  open: boolean;
  task: Task | null;
  onClose: () => void;
  onSave: (payload: {
    title: string;
    description: string;
    status: TaskStatus;
    priority: TaskPriority;
    dueDate: string | null;
  }) => Promise<Task>;
  onDelete?: (taskId: string) => Promise<void>;
}

export function TaskModal({ open, task, onClose, onSave, onDelete }: TaskModalProps) {
  const formRef = useRef<HTMLFormElement>(null);
  const titleId = useId();
  const titleErrId = useId();
  const descId = useId();
  const statusId = useId();
  const priorityId = useId();
  const dueDateId = useId();

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<TaskStatus>('todo');
  const [priority, setPriority] = useState<TaskPriority>('medium');
  const [dueDate, setDueDate] = useState('');

  const [saving, setSaving] = useState(false);
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
    setConfirmDelete(false);
    setError(null);
  }, [open, task]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!formRef.current?.reportValidity()) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({
        title: title.trim(),
        description: description.trim(),
        status,
        priority,
        dueDate: dueDate || null,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao salvar tarefa.');
    } finally {
      setSaving(false);
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
      title={task ? 'Editar tarefa' : 'Nova tarefa'}
      subtitle={
        task
          ? 'Atualize os dados da tarefa persistida no Amazon DynamoDB.'
          : 'Crie uma nova tarefa salva diretamente na sua partição do DynamoDB.'
      }
      size="md"
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
            placeholder="Ex.: Revisar roteiro da apresentação de SD"
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
            placeholder="Detalhes, anotações ou próximos passos..."
            className="field-input mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-blue-600 focus:ring-2 focus:ring-blue-600/20"
          />
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
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
              disabled={saving}
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
