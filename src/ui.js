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
