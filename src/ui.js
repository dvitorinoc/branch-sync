// Apresentação no terminal: cores ANSI com fallback automático quando não há
// TTY (saída redirecionada/pipe) ou quando `NO_COLOR` está definido. Mantido
// sem dependências externas — o projeto evita libs de estilo (chalk etc.).
//
// Usado para deixar a exibição de conflitos mais legível (lista, revisor e
// marcadores). Cada função recebe uma string e devolve a string colorida — ou
// a própria string, intacta, quando as cores estão desligadas.

const enabled = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

const paint = (open, close) => (s) =>
  enabled ? `\x1b[${open}m${s}\x1b[${close}m` : String(s);

export const bold = paint(1, 22);
export const dim = paint(2, 22);
export const red = paint(31, 39);
export const green = paint(32, 39);
export const yellow = paint(33, 39);
export const cyan = paint(36, 39);
export const gray = paint(90, 39);

// Limpa a tela e o scrollback do terminal entre etapas do revisor, para que as
// saídas de um arquivo (proposta, diff, marcadores) não se acumulem ao voltar
// para a lista. No-op quando a saída não é um TTY (pipe/redirecionamento), para
// preservar o log intacto. `\x1b[2J` limpa a tela, `\x1b[3J` o scrollback e
// `\x1b[H` reposiciona o cursor no topo.
export function clearScreen() {
  if (process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
}

// Largura útil do terminal, com teto para não gerar caixas gigantes em telas
// muito largas. Fallback 80 quando não há TTY (saída redirecionada).
export function termWidth(max = 120) {
  const w = process.stdout.columns;
  return Math.min(max, w && w > 0 ? w : 80);
}

// Ajusta uma string de texto puro para EXATAMENTE `w` colunas visíveis: expande
// tabs, corta com reticências quando passa, completa com espaços quando falta.
function fit(s, w) {
  if (w <= 0) return '';
  const t = String(s).replace(/\t/g, '  ').replace(/\r/g, '');
  if (t.length > w) return t.slice(0, Math.max(0, w - 1)) + '…';
  return t + ' '.repeat(w - t.length);
}

// Monta as linhas de uma caixa (borda + título + conteúdo) com largura externa
// EXATA de `w` colunas visíveis. `content` é um array de linhas de texto puro;
// `color` pinta a borda e o título sai em negrito. As linhas retornadas podem
// conter ANSI, mas sua largura VISÍVEL é sempre `w` — por isso, ao combiná-las
// com `sideBySide`, passe os mesmos `w` em vez de medir `.length`.
export function box(title, content, w, color = (s) => s) {
  const cw = Math.max(1, w - 4); // conteúdo entre "│ " e " │"
  const tmax = Math.max(1, w - 6);
  const t = title.length > tmax ? `${title.slice(0, tmax - 1)}…` : title;
  const dashes = Math.max(0, w - 5 - t.length);
  const out = [color(`┌─ `) + bold(t) + color(` ${'─'.repeat(dashes)}┐`)];
  for (const raw of content.length ? content : ['']) {
    out.push(`${color('│')} ${fit(raw, cw)} ${color('│')}`);
  }
  out.push(color(`└${'─'.repeat(w - 2)}┘`));
  return out;
}

// Junta duas caixas lado a lado. `wa`/`wb` são as larguras visíveis de cada
// caixa; onde uma é mais alta que a outra, a linha faltante vira espaços da
// largura correspondente, mantendo o alinhamento.
export function sideBySide(a, wa, b, wb, gap = 2) {
  const n = Math.max(a.length, b.length);
  const g = ' '.repeat(gap);
  const blankA = ' '.repeat(wa);
  const blankB = ' '.repeat(wb);
  const out = [];
  for (let i = 0; i < n; i++) out.push((a[i] ?? blankA) + g + (b[i] ?? blankB));
  return out;
}
