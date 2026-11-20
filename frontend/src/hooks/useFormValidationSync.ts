import { useEffect } from 'react';

/**
 * Sincroniza aria-invalid e aria-describedby com :user-invalid (com fallback
 * para navegadores sem suporte a :user-invalid) e anuncia erros via live region.
 */
export function useFormValidationSync(
  formRef: React.RefObject<HTMLFormElement | null>,
  active: boolean,
) {
  useEffect(() => {
    const form = formRef.current;
    if (!form || !active) return;

    const supportsUserInvalid =
      typeof CSS !== 'undefined' &&
      typeof CSS.supports === 'function' &&
      CSS.supports('selector(:user-invalid)');

    const announcer = document.createElement('div');
    announcer.setAttribute('aria-live', 'polite');
    announcer.className = 'visually-hidden';
    form.append(announcer);

    const dirtyState = new WeakMap<Element, { interacted: boolean; blurred: boolean }>();
    const announced = new WeakSet<Element>();
    let announceTimer: number | undefined;

    const linkError = (el: HTMLElement, shown: boolean) => {
      const errorId = el.dataset.error;
      if (!errorId) return;
      const ids = (el.getAttribute('aria-describedby') || '')
        .split(/\s+/)
        .filter((id) => id && id !== errorId);
      if (shown) ids.push(errorId);
      if (ids.length) el.setAttribute('aria-describedby', ids.join(' '));
      else el.removeAttribute('aria-describedby');
    };

    const announceError = (el: HTMLElement) => {
      const errorId = el.dataset.error;
      if (!errorId) return;
      const errorNode = document.getElementById(errorId);
      if (!errorNode) return;
      window.clearTimeout(announceTimer);
      announcer.textContent = '';
      announceTimer = window.setTimeout(() => {
        announcer.textContent = errorNode.textContent?.trim() || '';
      }, 350);
    };

    const syncControl = (target: EventTarget | null, shouldAnnounce = false) => {
      if (!(target instanceof HTMLElement)) return;
      if (!target.matches('input, select, textarea')) return;

      const input = target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
      const invalid = supportsUserInvalid
        ? input.matches(':user-invalid')
        : input.classList.contains('user-invalid-fallback');

      input.setAttribute('aria-invalid', invalid ? 'true' : 'false');
      linkError(input, invalid);

      if (invalid && shouldAnnounce && !announced.has(input)) {
        announceError(input);
        announced.add(input);
      } else if (!invalid) {
        announced.delete(input);
      }
    };

    form.querySelectorAll('input, select, textarea').forEach((el) => {
      el.setAttribute('aria-invalid', 'false');
    });

    const onBlur = (e: Event) => {
      const target = e.target;
      if (!supportsUserInvalid && target instanceof HTMLElement && target.matches('input, select, textarea')) {
        const input = target as HTMLInputElement;
        const state = dirtyState.get(input) || { interacted: false, blurred: false };
        state.blurred = true;
        dirtyState.set(input, state);
        if (state.interacted) {
          input.classList.toggle('user-invalid-fallback', !input.validity.valid);
        }
      }
      syncControl(target, true);
    };

    const onInput = (e: Event) => {
      const target = e.target;
      if (!supportsUserInvalid && target instanceof HTMLElement && target.matches('input, select, textarea')) {
        const input = target as HTMLInputElement;
        const state = dirtyState.get(input) || { interacted: false, blurred: false };
        state.interacted = true;
        dirtyState.set(input, state);
        if (state.blurred) {
          input.classList.toggle('user-invalid-fallback', !input.validity.valid);
        }
      }
      syncControl(target, false);
    };

    const onInvalid = (e: Event) => {
      const target = e.target;
      if (!supportsUserInvalid && target instanceof HTMLElement && target.matches('input, select, textarea')) {
        target.classList.add('user-invalid-fallback');
      }
      if (target instanceof HTMLElement) {
        announced.add(target);
      }
      syncControl(target, false);
    };

    form.addEventListener('blur', onBlur, true);
    form.addEventListener('input', onInput);
    form.addEventListener('invalid', onInvalid, true);

    return () => {
      window.clearTimeout(announceTimer);
      form.removeEventListener('blur', onBlur, true);
      form.removeEventListener('input', onInput);
      form.removeEventListener('invalid', onInvalid, true);
      announcer.remove();
    };
  }, [formRef, active]);
}
