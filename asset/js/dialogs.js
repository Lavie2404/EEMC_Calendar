// Simple promise-based dialog helpers (alert/confirm) using a DOM-rooted popup.
// Exports: alertDialog(message, opts), confirmDialog(message, opts)
const DIALOG_ROOT_ID = 'dialog-root';

function ensureRoot() {
  let root = document.getElementById(DIALOG_ROOT_ID);
  if (!root) {
    root = document.createElement('div');
    root.id = DIALOG_ROOT_ID;
    document.body.appendChild(root);
  }
  return root;
}

function buildDialog(message, { buttons = [] } = {}) {
  const overlay = document.createElement('div');
  overlay.className = 'dialog-overlay';
  overlay.tabIndex = -1;

  const panel = document.createElement('div');
  panel.className = 'dialog-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');

  const msg = document.createElement('div');
  msg.className = 'dialog-message';
  msg.textContent = message;
  panel.appendChild(msg);

  const btns = document.createElement('div');
  btns.className = 'dialog-buttons';
  buttons.forEach(b => {
    const btn = document.createElement('button');
    btn.className = `dialog-btn ${b.class || ''}`.trim();
    btn.textContent = b.label || 'OK';
    btn.addEventListener('click', () => b.onClick && b.onClick());
    btns.appendChild(btn);
  });
  panel.appendChild(btns);

  overlay.appendChild(panel);
  return { overlay, panel };
}

function showOverlay(elem) {
  const root = ensureRoot();
  root.appendChild(elem);
  // allow CSS transitions
  requestAnimationFrame(() => {
    elem.classList.add('show');
    const panel = elem.querySelector('.dialog-panel');
    if (panel) panel.classList.add('show');
    try { elem.focus(); } catch (e) {}
  });
}

function hideOverlay(elem) {
  if (!elem) return;
  elem.classList.remove('show');
  const panel = elem.querySelector('.dialog-panel');
  if (panel) panel.classList.remove('show');
  setTimeout(() => { try { elem.remove(); } catch (e) {} }, 220);
}

export function alertDialog(message, opts = {}) {
  return new Promise(resolve => {
    const { overlay, panel } = buildDialog(message, {
      buttons: [
        { label: opts.okLabel || 'OK', class: 'confirm', onClick: () => {
          hideOverlay(overlay);
          resolve();
        } }
      ]
    });

    overlay.addEventListener('click', (e) => {
      // click outside should not close alert to avoid accidental dismissals
      if (e.target === overlay && opts.allowOutsideClose) {
        hideOverlay(overlay);
        resolve();
      }
    });

    showOverlay(overlay);
  });
}

export function confirmDialog(message, opts = {}) {
  return new Promise(resolve => {
    const { overlay } = buildDialog(message, {
      buttons: [
        { label: opts.cancelLabel || 'Hủy', class: 'cancel', onClick: () => { hideOverlay(overlay); resolve(false); } },
        { label: opts.okLabel || 'OK', class: 'confirm', onClick: () => { hideOverlay(overlay); resolve(true); } }
      ]
    });

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay && opts.allowOutsideClose) {
        hideOverlay(overlay);
        resolve(false);
      }
    });

    showOverlay(overlay);
  });
}

// Provide global helpers as convenience for non-module callers
try { window.alertDialog = alertDialog; window.confirmDialog = confirmDialog; } catch (e) {}
