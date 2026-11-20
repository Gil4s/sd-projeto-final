import { useEffect, useId, useRef, useState } from 'react';
import { ModalDialog } from './ModalDialog';
import { useFormValidationSync } from '../hooks/useFormValidationSync';
import type { Project } from '../types';

const COLOR_OPTIONS = [
  { hex: '#2563eb', label: 'Azul' },
  { hex: '#0f766e', label: 'Verde-petróleo' },
  { hex: '#059669', label: 'Esmeralda' },
  { hex: '#d97706', label: 'Âmbar' },
  { hex: '#dc2626', label: 'Vermelho' },
  { hex: '#7c3aed', label: 'Roxo' },
  { hex: '#0284c7', label: 'Ciano' },
  { hex: '#475569', label: 'Ardósia' },
];

interface ProjectModalProps {
  open: boolean;
  project: Project | null;
  onClose: () => void;
  onSave: (payload: { name: string; description: string; color: string }) => Promise<void>;
}

export function ProjectModal({ open, project, onClose, onSave }: ProjectModalProps) {
  const formRef = useRef<HTMLFormElement>(null);
  const nameId = useId();
  const nameErrId = useId();
  const descId = useId();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState('#2563eb');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useFormValidationSync(formRef, open);

  useEffect(() => {
    if (!open) return;
    setName(project?.name || '');
    setDescription(project?.description || '');
    setColor(project?.color || '#2563eb');
    setError(null);
  }, [open, project]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!formRef.current?.reportValidity()) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({ name: name.trim(), description: description.trim(), color });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao salvar projeto.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalDialog
      open={open}
      onClose={onClose}
      title={project ? 'Editar projeto' : 'Novo projeto'}
      subtitle="Os projetos organizam suas tarefas na partição privada do DynamoDB."
    >
      <form ref={formRef} onSubmit={handleSubmit} className="space-y-4">
        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-700">
            {error}
          </div>
        )}

        <div>
          <label htmlFor={nameId} className="block text-sm font-medium text-slate-700">
            Nome do projeto *
          </label>
          <span className="mt-0.5 block text-xs text-slate-500">
            Entre 2 e 80 caracteres (ex.: Sistemas Distribuídos, TCC).
          </span>
          <input
            id={nameId}
            type="text"
            required
            minLength={2}
            maxLength={80}
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            data-error={nameErrId}
            placeholder="Ex.: Sistemas Distribuídos 2026"
            className="field-input mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-blue-600 focus:ring-2 focus:ring-blue-600/20"
          />
          <div id={nameErrId} className="field-error">
            Erro: informe um nome de projeto com pelo menos 2 caracteres.
          </div>
        </div>

        <div>
          <label htmlFor={descId} className="block text-sm font-medium text-slate-700">
            Descrição
          </label>
          <textarea
            id={descId}
            rows={3}
            maxLength={300}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Resumo opcional do escopo ou entregas..."
            className="field-input mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-blue-600 focus:ring-2 focus:ring-blue-600/20"
          />
        </div>

        <fieldset>
          <legend className="text-sm font-medium text-slate-700">Cor de identificação</legend>
          <div className="mt-2 flex flex-wrap gap-2.5">
            {COLOR_OPTIONS.map((opt) => (
              <button
                key={opt.hex}
                type="button"
                onClick={() => setColor(opt.hex)}
                aria-label={`Cor ${opt.label}`}
                aria-pressed={color === opt.hex}
                className={`h-8 w-8 rounded-full transition ${
                  color === opt.hex
                    ? 'scale-110 ring-2 ring-slate-900 ring-offset-2'
                    : 'hover:scale-105'
                }`}
                style={{ backgroundColor: opt.hex }}
              />
            ))}
          </div>
        </fieldset>

        <div className="flex items-center justify-end gap-2.5 border-t border-slate-100 pt-4">
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
            {saving ? 'Salvando...' : project ? 'Salvar alterações' : 'Criar projeto'}
          </button>
        </div>
      </form>
    </ModalDialog>
  );
}
