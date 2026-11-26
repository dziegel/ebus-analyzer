// Copying text. The clipboard API exists only in secure contexts (https or
// localhost); the app is usually opened as http://<bridge-host>:8080 (Q2), so
// fall back to the older copy command on a temporary text field.

export async function copyText(text: string): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // permission denied: try the fallback
    }
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '0';
  ta.style.left = '0';
  ta.style.opacity = '0';
  // outside an open modal dialog the field would be inert and not selectable
  const host = document.querySelector('dialog[open]') ?? document.body;
  host.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

/**
 * Copies and shows the result on the button for a moment. If copying is not
 * possible, `select` (e.g. the text area with the text) is selected so that
 * the user can press Ctrl+C.
 */
export async function copyWithFeedback(button: HTMLElement, text: string, select?: HTMLTextAreaElement | HTMLInputElement): Promise<void> {
  const ok = await copyText(text);
  if (!ok && select) {
    select.focus();
    select.select();
  }
  const label = button.dataset.label ?? button.textContent ?? '';
  button.dataset.label = label;
  button.textContent = ok ? 'Copied' : select ? 'Press Ctrl+C' : 'Copy failed';
  setTimeout(() => {
    button.textContent = button.dataset.label ?? label;
  }, 1500);
}
