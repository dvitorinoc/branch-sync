import { execSync } from 'node:child_process';

// Execução do comando de build do repositório, usado para regerar arquivos
// ignorados na resolução (ex.: *.map) depois que os conflitos "de verdade"
// foram resolvidos. A identificação de quais arquivos ignorar está em `ignore.js`.

const TIMEOUT_MS = 10 * 60 * 1000; // builds podem demorar; 10 min é um teto generoso.

// Roda o comando de build do repositório, com a saída exibida ao vivo (build
// costuma ser demorado — mostrar progresso evita a sensação de travamento).
// Retorna { ok, code }.
export function runBuild(cwd, command) {
  try {
    execSync(command, { cwd, stdio: 'inherit', timeout: TIMEOUT_MS });
    return { ok: true, code: 0 };
  } catch (e) {
    return { ok: false, code: e.status ?? 1 };
  }
}
