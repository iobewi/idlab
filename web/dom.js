export const $ = id => document.getElementById(id);
let noticeTimer;

export function say(message, {temporary = false} = {}) {
  clearTimeout(noticeTimer);
  const status = $('client-state');
  status.textContent = message;
  if (temporary) noticeTimer = setTimeout(() => { status.textContent = ''; }, 5000);
}
export const clock = new Intl.DateTimeFormat('fr', { timeStyle: 'medium' });
export const number = new Intl.NumberFormat('fr', {maximumFractionDigits: 1});

export function element(tag, content, cls) {
  const el = document.createElement(tag);
  if (content !== undefined) el.textContent = content;
  if (cls) el.className = cls;
  return el;
}

export async function run(action) {
  say('');
  try {
    return await action();
  } catch (error) {
    say(error.message);
  }
}

export function download(blob, filename) {
  const link = element('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}
