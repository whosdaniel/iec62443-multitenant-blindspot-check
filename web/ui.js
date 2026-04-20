// Small DOM helpers shared across canvas / chips / app modules.
//
// Rules enforced here:
//   - Every piece of user-typed text passes through sanitizeText before
//     being rendered or stored. We never touch innerHTML.
//   - Modals are promise-based; onConfirm can return undefined to reject
//     validation and keep the modal open.
//   - Context menu is a DOM overlay, not a browser-native menu, so it
//     obeys the page's CSP (no 'unsafe-inline' scripts).

/**
 * Strip control characters except TAB/LF/CR and truncate.
 * Used before rendering user input (labels, notes) or storing it.
 *
 * Stripped ranges:
 *   - C0 controls except TAB/LF/CR  (U+0000..U+0008, U+000B..U+001F)
 *   - DEL                           (U+007F)
 *   - C1 controls incl. NEL         (U+0080..U+009F)
 *   - Line/paragraph separators      (U+2028, U+2029)
 *
 * The C1 and separator ranges matter specifically for the JS -> YAML
 * export -> Python CLI round trip: PyYAML 1.1 (the spec PyYAML 6.x
 * implements for safe_load) silently normalises NEL (U+0085) to an
 * ASCII space inside double-quoted scalars, so any user text containing
 * NEL (common in copy-paste from legacy Windows or macOS documents)
 * would round-trip lossily. Stripping at sanitize time matches what
 * the user sees on canvas to what ends up on disk.
 */
export function sanitizeText(s, max = 200) {
  if (typeof s !== 'string') return '';
  const cleaned = s.replace(
    /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u2028\u2029]/g,
    '',
  );
  return cleaned.slice(0, max);
}

// Status messages are assertively-announced via the aria-live region
// in index.html. We debounce rapid-fire updates so screen readers
// aren't flooded with fragments that get clipped by the next message
// arriving 50ms later (UX agent 5 A11Y-04).
let _statusLastText = '';
let _statusTimer = null;
export function showStatus(text) {
  const el = document.getElementById('status');
  if (!el) return;
  const next = String(text ?? '');
  if (next === _statusLastText) return;
  if (_statusTimer) clearTimeout(_statusTimer);
  _statusTimer = setTimeout(() => {
    el.textContent = next;
    _statusLastText = next;
    _statusTimer = null;
  }, 150);
}

// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------

let _contextMenu = null;

/**
 * Show a right-click context menu near (x, y).
 *
 * @param {number} x - clientX of the triggering event.
 * @param {number} y - clientY of the triggering event.
 * @param {Array<{label: string, action: () => void} | null>} items
 *        Menu items; `null` inserts a visual separator.
 */
export function showContextMenu(x, y, items) {
  hideContextMenu();
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.setAttribute('role', 'menu');

  const ul = document.createElement('ul');
  for (const item of items) {
    if (item === null) {
      const sep = document.createElement('li');
      sep.className = 'separator';
      sep.setAttribute('role', 'separator');
      ul.appendChild(sep);
      continue;
    }
    const li = document.createElement('li');
    li.setAttribute('role', 'none');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('role', 'menuitem');
    btn.textContent = item.label;
    btn.addEventListener('click', () => {
      hideContextMenu();
      item.action();
    });
    li.appendChild(btn);
    ul.appendChild(li);
  }
  menu.appendChild(ul);
  document.body.appendChild(menu);

  // Clamp to viewport.
  const rect = menu.getBoundingClientRect();
  const vx = Math.min(x, window.innerWidth - rect.width - 4);
  const vy = Math.min(y, window.innerHeight - rect.height - 4);
  menu.style.left = `${Math.max(0, vx)}px`;
  menu.style.top = `${Math.max(0, vy)}px`;
  _contextMenu = menu;

  // Dismiss on click / contextmenu / escape / scroll.
  const dismiss = (e) => {
    if (e && menu.contains(e.target)) return;
    hideContextMenu();
  };
  const key = (e) => {
    if (e.key === 'Escape') hideContextMenu();
  };
  setTimeout(() => {
    document.addEventListener('click', dismiss);
    document.addEventListener('contextmenu', dismiss);
    document.addEventListener('keydown', key);
    window.addEventListener('scroll', dismiss, true);
    menu.__cleanup = () => {
      document.removeEventListener('click', dismiss);
      document.removeEventListener('contextmenu', dismiss);
      document.removeEventListener('keydown', key);
      window.removeEventListener('scroll', dismiss, true);
    };
  }, 0);
}

export function hideContextMenu() {
  if (_contextMenu) {
    if (typeof _contextMenu.__cleanup === 'function') _contextMenu.__cleanup();
    _contextMenu.remove();
    _contextMenu = null;
  }
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

/**
 * Show a modal dialog. Returns a promise that resolves with the result of
 * onConfirm (or null if cancelled). If onConfirm returns undefined, the
 * modal stays open - use that to signal validation failure.
 */
export function showModal({
  title,
  bodyElements,
  confirmLabel = 'OK',
  cancelLabel = 'Cancel',
  onConfirm,
}) {
  return new Promise((resolve) => {
    // Remember the element that had focus before the modal opened so
    // we can restore it on close (UX agent 5 A11Y-02, WCAG 2.4.3).
    const savedFocus = document.activeElement;

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');

    const modal = document.createElement('div');
    modal.className = 'modal';

    const titleId = `modal-title-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const h3 = document.createElement('h3');
    h3.id = titleId;
    h3.textContent = title;
    backdrop.setAttribute('aria-labelledby', titleId);
    modal.appendChild(h3);

    const body = document.createElement('div');
    body.className = 'modal-body';
    for (const el of bodyElements) body.appendChild(el);
    modal.appendChild(body);

    const actions = document.createElement('div');
    actions.className = 'modal-actions';

    let cancelBtn = null;
    if (cancelLabel !== null) {
      cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.textContent = cancelLabel;
    }

    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'primary';
    confirmBtn.textContent = confirmLabel;

    if (cancelBtn) actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);
    modal.appendChild(actions);

    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    const close = (result) => {
      backdrop.remove();
      document.removeEventListener('keydown', keyHandler);
      // Return focus to the trigger element so keyboard users don't
      // fall off a cliff (A11Y-02).
      try {
        if (savedFocus && typeof savedFocus.focus === 'function' && document.contains(savedFocus)) {
          savedFocus.focus();
        }
      } catch { /* ignore */ }
      resolve(result);
    };

    if (cancelBtn) cancelBtn.addEventListener('click', () => close(null));
    confirmBtn.addEventListener('click', () => {
      const result = onConfirm ? onConfirm() : true;
      if (result !== undefined) close(result);
    });
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close(null);
    });

    const keyHandler = (e) => {
      if (e.key === 'Escape') { close(null); return; }
      if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
        const result = onConfirm ? onConfirm() : true;
        if (result !== undefined) close(result);
        return;
      }
      // Focus trap: keep Tab/Shift+Tab inside the modal so keyboard
      // focus cannot leak to the background (A11Y-02).
      if (e.key === 'Tab') {
        const focusables = modal.querySelectorAll(
          'button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last  = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', keyHandler);

    // Focus the first input, or the confirm button.
    const firstInput = body.querySelector('input, textarea, select');
    if (firstInput) firstInput.focus();
    else confirmBtn.focus();
  });
}

// ---------------------------------------------------------------------------
// Regex helpers re-used from the schema so chip/edge IDs match the
// constraints the Python-side validator enforces.
// ---------------------------------------------------------------------------

export const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export function isValidId(s) {
  return typeof s === 'string' && ID_PATTERN.test(s);
}
