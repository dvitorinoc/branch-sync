import { loadConfig, loadState, getRepo } from '../config.js';
import { resolveRepo } from './repo.js';
import { runConflictExplanation } from './update.js';
import { isGitRepo, mergeInProgress, conflictedFiles, currentBranch } from '../git.js';

// Analisa, sob demanda, o conflito de merge atual de um repositório.
// Útil para re-rodar a explicação (ou trocar de provedor: --ai codex) depois
// de já ter visto os arquivos em conflito.
export async function explainCommand(repoArg, opts) {
  const cfg = loadConfig();

  // Sem repo explícito, tenta o repositório da sincronização em andamento.
  let repo;
  if (!repoArg) {
    const state = loadState();
    if (state) repo = getRepo(cfg, state.repo);
  }
  if (!repo) repo = await resolveRepo(cfg, repoArg);

  if (!isGitRepo(repo.path)) {
    console.error(`✖ "${repo.path}" não é mais um repositório git válido.`);
    process.exit(1);
  }

  if (!mergeInProgress(repo.path)) {
    console.error(
      `Nenhum merge em andamento em "${repo.name}". Rode "branch-sync update" primeiro (nada para explicar).`,
    );
    process.exit(1);
  }

  const files = conflictedFiles(repo.path);
  if (!files.length) {
    console.error(
      `O merge em "${repo.name}" não tem mais arquivos em conflito (já resolvidos?).`,
    );
    process.exit(1);
  }

  // A branch atual é o destino do merge; a produção configurada é a origem.
  const branch = currentBranch(repo.path);
  runConflictExplanation(repo.path, repo.mainBranch, branch, files, opts.ai ?? 'auto');
}
