import { input, select, checkbox } from '@inquirer/prompts';
import { loadConfig, saveConfig } from '../config.js';
import { resolveRepo } from './repo.js';
import { branchExists, localBranches } from '../git.js';

export async function branchAdd(branchArg, opts) {
  const cfg = loadConfig();
  const repo = await resolveRepo(cfg, opts.repo);

  let branch = branchArg;

  if (!branch) {
    // Oferece um seletor com os branches locais ainda não monitorados.
    let candidates = [];
    try {
      candidates = localBranches(repo.path).filter(
        (b) => b !== repo.mainBranch && !repo.branches.includes(b),
      );
    } catch {
      /* ignora — cai no input manual */
    }

    if (candidates.length) {
      branch = await select({
        message: `Qual branch monitorar em "${repo.name}"?`,
        choices: [
          ...candidates.map((b) => ({ name: b, value: b })),
          { name: '✎ digitar outro nome…', value: '__manual__' },
        ],
      });
    }
    if (!branch || branch === '__manual__') {
      branch = await input({
        message: 'Nome da branch:',
        validate: (v) => (v.trim() ? true : 'Informe o nome da branch.'),
      });
    }
  }

  branch = branch.trim();

  if (branch === repo.mainBranch) {
    console.error(
      `✖ "${branch}" é a branch de produção; não faz sentido monitorá-la.`,
    );
    process.exit(1);
  }
  if (repo.branches.includes(branch)) {
    console.error(`A branch "${branch}" já está monitorada em "${repo.name}".`);
    process.exit(1);
  }
  if (!branchExists(repo.path, branch)) {
    console.error(`✖ A branch "${branch}" não existe em "${repo.name}".`);
    process.exit(1);
  }

  repo.branches.push(branch);
  saveConfig(cfg);
  console.log(`✔ "${branch}" adicionada à lista de "${repo.name}".`);
}

export async function branchRemove(branchArg, opts) {
  const cfg = loadConfig();
  const repo = await resolveRepo(cfg, opts.repo);

  if (!repo.branches.length) {
    console.error(`"${repo.name}" não possui branches monitoradas.`);
    process.exit(1);
  }

  let branches;
  if (branchArg) {
    branches = [branchArg.trim()];
  } else {
    branches = await checkbox({
      message: `Remover quais branches de "${repo.name}"?`,
      choices: repo.branches.map((b) => ({ name: b, value: b })),
      validate: (a) => (a.length ? true : 'Selecione ao menos uma.'),
    });
  }

  const before = repo.branches.length;
  repo.branches = repo.branches.filter((b) => !branches.includes(b));
  saveConfig(cfg);
  console.log(
    `✔ ${before - repo.branches.length} branch(es) removida(s) de "${repo.name}".`,
  );
}

export async function branchList(opts) {
  const cfg = loadConfig();
  const repo = await resolveRepo(cfg, opts.repo);
  console.log(`\nBranches monitoradas em "${repo.name}" (produção: ${repo.mainBranch}):`);
  if (!repo.branches.length) {
    console.log('  (nenhuma)\n');
    return;
  }
  for (const b of repo.branches) console.log(`  • ${b}`);
  console.log('');
}
