#!/usr/bin/env node
import { Command } from 'commander';
import { configPath } from '../src/config.js';
import { repoAdd, repoRemove, repoList, repoIgnore } from '../src/commands/repo.js';
import { branchAdd, branchRemove, branchList } from '../src/commands/branch.js';
import { updateCommand } from '../src/commands/update.js';
import { explainCommand } from '../src/commands/explain.js';

const program = new Command();

program
  .name('branch-sync')
  .description(
    'Atualiza uma lista de branches com a branch de produção de um repositório.',
  )
  .version('1.0.0');

// ---- repo ----
const repo = program.command('repo').description('Gerencia repositórios.');
repo.command('add').description('Adiciona um repositório (caminho, nome e branch de produção).').action(repoAdd);
repo.command('remove').alias('rm').argument('[name]', 'nome do repositório').description('Remove um repositório.').action(repoRemove);
repo.command('list').alias('ls').description('Lista os repositórios configurados.').action(repoList);
repo
  .command('ignore')
  .argument('[patterns...]', 'padrões a ignorar (ex.: *.map "include/build/*"); omita para editar por prompt')
  .option('-r, --repo <name>', 'repositório alvo')
  .description('Define os arquivos ignorados na resolução de conflitos (não são resolvidos pela IA).')
  .action(repoIgnore);

// ---- branch ----
const branch = program.command('branch').description('Gerencia as branches monitoradas de um repositório.');
branch
  .command('add')
  .argument('[branch]', 'nome da branch')
  .option('-r, --repo <name>', 'repositório alvo')
  .description('Adiciona uma branch à lista de atualização.')
  .action(branchAdd);
branch
  .command('remove')
  .alias('rm')
  .argument('[branch]', 'nome da branch')
  .option('-r, --repo <name>', 'repositório alvo')
  .description('Remove uma branch da lista de atualização.')
  .action(branchRemove);
branch
  .command('list')
  .alias('ls')
  .option('-r, --repo <name>', 'repositório alvo')
  .description('Lista as branches monitoradas.')
  .action(branchList);

// ---- update ----
program
  .command('update')
  .argument('[repo]', 'nome do repositório (omita para escolher por prompt)')
  .option('--abort', 'cancela uma sincronização em andamento e limpa o estado')
  .option('--no-fetch', 'não sincroniza as branches com o remoto antes de mesclar (fetch é o padrão)')
  .option('--no-push', 'não faz push das branches ao final (push é o padrão)')
  .option(
    '-m, --message <template>',
    'mensagem de commit do merge; placeholders {branch} e {prod}',
  )
  .option('--explain', 'em caso de conflito, usa IA para analisar e explicar os conflitos (provedor: auto)')
  .option(
    '--ai <provedor>',
    'provedor de IA para a análise: claude | codex | auto (implica --explain)',
  )
  .option(
    '--resolve',
    'em caso de conflito, usa IA para propor a resolução de cada arquivo, pedindo confirmação antes de aplicar (provedor via --ai)',
  )
  .description(
    'Mescla a branch de produção em cada branch monitorada. Pausa em conflitos e retoma na próxima execução.',
  )
  .action(updateCommand);

// ---- explain ----
program
  .command('explain')
  .argument('[repo]', 'nome do repositório (omita para usar o da sincronização em andamento)')
  .option('--ai <provedor>', 'provedor de IA: claude | codex | auto', 'auto')
  .description('Usa IA para analisar e explicar o conflito de merge atual de um repositório.')
  .action(explainCommand);

// ---- config ----
program
  .command('config')
  .description('Mostra o caminho do arquivo de configuração.')
  .action(() => console.log(configPath()));

async function main() {
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    // Ctrl+C nos prompts do inquirer.
    if (err && (err.name === 'ExitPromptError' || err.code === 'ABORT_ERR')) {
      console.log('\nCancelado.');
      process.exit(130);
    }
    console.error(`✖ ${err.message}`);
    process.exit(1);
  }
}

main();
