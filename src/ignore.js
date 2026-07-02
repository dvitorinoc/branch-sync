// Lista de arquivos que o branch-sync NÃO deve tentar resolver em um conflito
// (ex.: artefatos de build como *.map). O casamento segue um subconjunto da
// semântica do .gitignore, para ser intuitivo:
//
// - Padrão SEM barra (ex.: "*.map")        → casa pelo nome, em QUALQUER pasta.
// - Padrão COM barra (ex.: "include/build/*") → ancorado na raiz do repositório.
// - "*" casa qualquer coisa exceto "/"; "**" casa através de "/"; "?" casa um
//   caractere que não seja "/".
// - Barra no fim (ex.: "dist/") casa o diretório e tudo abaixo dele.
// - Linhas vazias e começadas por "#" são ignoradas.

// Converte o corpo de um glob em fonte de regex (sem âncoras).
function globBody(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++; // "**/": permite zero diretórios
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return re;
}

// Compila um padrão em RegExp (ou null se for vazio/comentário).
function compile(raw) {
  let p = (raw || '').trim();
  if (!p || p.startsWith('#')) return null;
  const dirOnly = /\/$/.test(p);
  p = p.replace(/\/+$/, '');
  // Barra no início ou no meio ancora o padrão na raiz; senão casa em qualquer nível.
  const anchored = p.includes('/');
  p = p.replace(/^\/+/, '');
  if (!p) return null;
  const prefix = anchored ? '^' : '(?:^|.*/)';
  const suffix = dirOnly ? '/.*$' : '(?:/.*)?$';
  return new RegExp(prefix + globBody(p) + suffix);
}

// Dentre `files` (caminhos relativos ao repo), retorna os que casam com algum
// dos `patterns` de ignore.
export function matchIgnored(files, patterns) {
  const compiled = (patterns || []).map(compile).filter(Boolean);
  if (!compiled.length) return [];
  return files.filter((f) => compiled.some((re) => re.test(f)));
}
