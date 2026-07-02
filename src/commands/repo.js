import { resolve } from 'node:path';
import { input, select, confirm } from '@inquirer/prompts';
import { loadConfig, saveConfig, getRepo } from '../config.js';
import { isGitRepo, branchExists, currentBranch, localBranches } from '../git.js';

export async function repoAdd() {
  const cfg = loadConfig();

  const rawPath = await input({
    message: 'Caminho do repositório:',
    default: process.cwd(),
    validate: (v) => (v.trim() ? true : 'Informe um caminho.'),
  });
  const path = resolve(rawPath.trim());

  if (!isGitRepo(path)) {
    console.error(`✖ "${path}" não é um repositório git válido.`);
    process.exit(1);
  }

  const name = await input({
    message: 'Nome do repositório:',
    default: path.split('/').filter(Boolean).pop(),
    validate: (v) => {
      if (!v.trim()) return 'Informe um nome.';
      if (getRepo(cfg, v.trim())) return 'Já existe um repositório com esse nome.';
      return true;
    },
  });

  let currentDefault = 'main';
  try {
    currentDefault = currentBranch(path);
  } catch {
    /* ignora */
  }

  const mainBranch = await input({
    message: 'Branch de produção (main):',
    default: currentDefault,
    validate: (v) => {
      if (!v.trim()) return 'Informe a branch principal.';
      if (!branchExists(path, v.trim()))
        return `A branch "${v.trim()}" não existe nesse repositório.`;
      return true;
    },
  });

  // Lista de ignore opcional: arquivos que não devem ser resolvidos no conflito
  // (ex.: *.map, include/build/*) — regerados pelo build ou pela versão da produção.
  const ignore = parsePatterns(
    await input({
      message: 'Padrões de arquivos a ignorar na resolução (vírgula; ex.: *.map, include/build/*):',
      default: '',
    }),
  );

  // Build opcional: se definido, regera os arquivos ignorados; senão, o
  // branch-sync adota a versão da produção para eles.
  const buildCommand = (
    await input({
      message: 'Comando de build para regerar os ignorados (opcional, Enter para nenhum):',
      default: '',
    })
  ).trim();

  const entry = {
    name: name.trim(),
    path,
    mainBranch: mainBranch.trim(),
    branches: [],
  };
  if (ignore.length) entry.ignore = ignore;
  if (buildCommand) entry.build = { command: buildCommand };

  cfg.repositories.push(entry);
  saveConfig(cfg);
  console.log(`✔ Repositório "${name.trim()}" adicionado.`);
}

// Divide uma string separada por vírgulas em padrões limpos e não-vazios.
function parsePatterns(raw) {
  return (raw || '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
}

// Define (substitui) a lista de arquivos ignorados na resolução de um repositório.
export async function repoIgnore(patternsArg, opts) {
  const cfg = loadConfig();
  const repo = await resolveRepo(cfg, opts?.repo);

  let patterns;
  if (patternsArg && patternsArg.length) {
    // Aceita tanto "a,b" num único argumento quanto argumentos separados.
    patterns = parsePatterns(patternsArg.join(','));
  } else {
    patterns = parsePatterns(
      await input({
        message: 'Padrões a ignorar (vírgula; vazio para limpar):',
        default: (repo.ignore ?? []).join(', '),
      }),
    );
  }

  if (patterns.length) repo.ignore = patterns;
  else delete repo.ignore;
  saveConfig(cfg);
  console.log(
    patterns.length
      ? `✔ Ignore de "${repo.name}" definido: ${patterns.join(', ')}`
      : `✔ Ignore de "${repo.name}" limpo.`,
  );
}

export async function repoRemove(nameArg) {
  const cfg = loadConfig();
  if (!cfg.repositories.length) {
    console.error('Nenhum repositório configurado.');
    process.exit(1);
  }

  const name =
    nameArg ||
    (await select({
      message: 'Remover qual repositório?',
      choices: cfg.repositories.map((r) => ({ name: r.name, value: r.name })),
    }));

  const repo = getRepo(cfg, name);
  if (!repo) {
    console.error(`Repositório "${name}" não encontrado.`);
    process.exit(1);
  }

  const ok = await confirm({
    message: `Remover "${repo.name}" (e suas ${repo.branches.length} branches monitoradas)?`,
    default: false,
  });
  if (!ok) return;

  cfg.repositories = cfg.repositories.filter((r) => r.name !== name);
  saveConfig(cfg);
  console.log(`✔ Repositório "${name}" removido.`);
}

export function repoList() {
  const cfg = loadConfig();
  if (!cfg.repositories.length) {
    console.log('Nenhum repositório configurado. Use "branch-sync repo add".');
    return;
  }
  for (const r of cfg.repositories) {
    console.log(`\n● ${r.name}`);
    console.log(`   caminho:   ${r.path}`);
    console.log(`   produção:  ${r.mainBranch}`);
    console.log(
      `   branches:  ${r.branches.length ? r.branches.join(', ') : '(nenhuma)'}`,
    );
    const ignore = [...(r.ignore ?? []), ...(r.build?.artifacts ?? [])];
    if (ignore.length) console.log(`   ignore:    ${ignore.join(', ')}`);
    if (r.build?.command) console.log(`   build:     ${r.build.command}`);
  }
  console.log('');
}

// Reaproveitado por outros comandos para resolver um repositório.
export async function resolveRepo(cfg, repoArg) {
  if (!cfg.repositories.length) {
    console.error('Nenhum repositório configurado. Use "branch-sync repo add".');
    process.exit(1);
  }
  if (repoArg) {
    const repo = getRepo(cfg, repoArg);
    if (!repo) {
      console.error(`Repositório "${repoArg}" não encontrado.`);
      process.exit(1);
    }
    return repo;
  }
  if (cfg.repositories.length === 1) return cfg.repositories[0];

  const name = await select({
    message: 'Selecione o repositório:',
    choices: cfg.repositories.map((r) => ({
      name: `${r.name}  (${r.branches.length} branches)`,
      value: r.name,
    })),
  });
  return getRepo(cfg, name);
}

export { localBranches };
