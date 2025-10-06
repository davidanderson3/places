export function linkify(text = '') {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  return escaped.replace(
    urlRegex,
    url => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`
  );
}

export function pickDate(initial = '') {
  if (!window.HTMLDialogElement || !document.createElement('dialog').showModal) {
    const val = prompt('Select date (YYYY-MM-DD):', initial);
    return Promise.resolve(val ? val.trim() : '');
  }
  return new Promise(resolve => {
    const dialog = document.createElement('dialog');
    const form = document.createElement('form');
    form.method = 'dialog';

    const input = document.createElement('input');
    input.type = 'date';
    input.value = initial;

    const ok = document.createElement('button');
    ok.textContent = 'OK';
    ok.value = 'default';

    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.value = 'cancel';

    const row = document.createElement('div');
    row.className = 'button-row';
    row.append(cancel, ok);

    form.append(input, row);
    dialog.append(form);
    document.body.appendChild(dialog);

    dialog.addEventListener('close', () => {
      const val = dialog.returnValue === 'cancel' ? '' : input.value;
      dialog.remove();
      resolve(val);
    });

    dialog.showModal();
    input.focus();
    input.showPicker?.();
  });
}
