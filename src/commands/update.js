import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { confirm } from '@inquirer/prompts';
import {
  loadConfig,
  loadState,
  saveState,
  clearState,
  getRepo,
} from '../config.js';
import { resolveRepo } from './repo.js';
import { explainConflicts, resolveProvider, resolveConflictFile } from '../ai.js';
import { runBuild } from '../build.js';
import { matchIgnored } from '../ignore.js';
import {
  git,
  tryGit,
  isGitRepo,
  isClean,
  currentBranch,
  branchExists,
  mergeInProgress,
  hasUpstream,
  upstreamRef,
  conflictedFiles,
} from '../git.js';

export async function updateCommand(repoArg, opts) {
  const cfg = loadConfig();

  if (opts.abort) {
    const state = loadState();
    clearState();
    console.log(
      state
        ? `✔ Sincronização de "${state.repo}" abortada. Estado limpo.\n  (o repositório foi deixado como está; resolva/aborte o merge manualmente se necessário)`
        : 'Nenhuma sincronização em andamento.',
    );
    return;
  }

  let state = loadState();

  // ---- Retomada de uma execução interrompida por conflito ----
  if (state) {
    const repo = getRepo(cfg, state.repo);
    if (!repo) {
      clearState();
      console.error(
        `Estado pendente apontava para "${state.repo}", que não existe mais. Estado limpo.`,
      );
      process.exit(1);
    }

    if (repoArg && repoArg !== state.repo) {
      console.error(
        `Há uma sincronização em andamento em "${state.repo}". ` +
          `Conclua-a (rode "branch-sync update") ou cancele ("branch-sync update --abort") antes de sincronizar "${repoArg}".`,
      );
      process.exit(1);
    }

    // Passar --resolve na retomada também liga a resolução por IA (e a
    // preferência fica persistida para as próximas branches da fila).
    const wantResolve = Boolean(opts.resolve) || Boolean(state.resolve);

    if (mergeInProgress(repo.path)) {
      const files = conflictedFiles(repo.path);
      console.error(
        `\n⏸  Merge ainda em andamento em "${repo.name}" na branch "${state.current}".`,
      );
      if (files.length) {
        console.error('   Arquivos em conflito:');
        for (const f of files) console.error(`     - ${f}`);
      }
      const sourceFiles = files.filter(
        (f) => !matchIgnored(files, ignorePatternsFor(repo)).includes(f),
      );
      if (state.explain && sourceFiles.length) {
        runConflictExplanation(repo.path, state.production, state.current, sourceFiles, state.ai ?? 'auto');
      }

      let merged = false;
      if (wantResolve && sourceFiles.length) {
        if (!state.resolve) {
          state.resolve = true;
          saveState(state);
        }
        merged = await runConflictResolution(
          repo.path,
          state.production,
          state.current,
          files,
          opts.ai ?? state.ai ?? 'auto',
          repo,
        );
      }
      // Se sobraram só arquivos ignorados (ou sem --resolve), trata-os e conclui.
      if (!merged) {
        merged = finalizeIgnoredFiles(repo.path, state.production, state.current, repo);
      }
      if (!merged) {
        console.error(
          '\n   Resolva os conflitos, então:\n' +
            '     git add <arquivos> && git commit   (ou git merge --continue)\n' +
            '   e rode "branch-sync update" novamente para prosseguir.\n',
        );
        process.exit(1);
      }
    }

    // Conflito resolvido: a branch atual está concluída.
    console.log(`▶ Retomando sincronização de "${repo.name}"…`);
    const completed = [...state.completed, state.current];
    await processQueue(repo, state.production, state.pending, completed, {
      updateProduction: false,
      push: state.push ?? true,
      fetch: state.fetch ?? true,
      message: state.message,
      explain: state.explain ?? false,
      ai: state.ai ?? 'auto',
      resolve: wantResolve,
    });
    return;
  }

  // ---- Execução nova ----
  const repo = await resolveRepo(cfg, repoArg);

  if (!isGitRepo(repo.path)) {
    console.error(`✖ "${repo.path}" não é mais um repositório git válido.`);
    process.exit(1);
  }
  if (!repo.branches.length) {
    console.error(
      `"${repo.name}" não tem branches monitoradas. Use "branch-sync branch add".`,
    );
    process.exit(1);
  }

  // A análise por IA é opcional: ligada por --explain ou por --ai <provedor>.
  const explain = Boolean(opts.explain) || (opts.ai != null && opts.ai !== 'off');
  const ai = opts.ai ?? 'auto';

  await processQueue(repo, repo.mainBranch, [...repo.branches], [], {
    updateProduction: true,
    push: opts.push !== false,
    fetch: opts.fetch !== false,
    message: opts.message,
    explain,
    ai,
    resolve: Boolean(opts.resolve),
  });
}

// Executa a análise de conflitos por IA e imprime o resultado. Nunca lança:
// a análise é auxiliar e não deve interromper o fluxo de resolução.
export function runConflictExplanation(cwd, production, branch, files, preferred) {
  if (!files.length) return;
  try {
    console.error(
      `\n🤖 Analisando os conflitos com IA (${preferred === 'auto' ? 'auto' : preferred})… ` +
        'isso pode levar alguns segundos.',
    );
    const result = explainConflicts({ cwd, production, branch, files, preferred });
    if (!result) return;
    console.error(`\n┌─ Análise (${result.label}) ${'─'.repeat(Math.max(0, 40 - result.label.length))}`);
    for (const line of result.text.split('\n')) console.error(`│ ${line}`);
    console.error(`└${'─'.repeat(48)}\n`);
  } catch (e) {
    console.error(`⚠ Não foi possível gerar a análise por IA: ${e.message}`);
  }
}

// Padrões de arquivos que NÃO devem ser resolvidos (lista de ignore do repo).
// Também aceita o campo legado `build.artifacts` como fonte de padrões.
export function ignorePatternsFor(repo) {
  return [...new Set([...(repo?.ignore ?? []), ...(repo?.build?.artifacts ?? [])])];
}

// Propõe, com IA, uma resolução para cada arquivo em conflito, pedindo
// confirmação antes de aplicar cada uma. Retorna true se TODOS os conflitos
// foram resolvidos e o merge foi commitado; false caso contrário. Nada é
// revertido em caso de falha: arquivos confirmados ficam no índice e os
// demais permanecem em conflito, prontos para resolução manual.
export async function runConflictResolution(cwd, production, branch, files, preferred, repo) {
  // Arquivos ignorados (ex.: *.map) não são resolvidos: são tratados no final
  // — regerados pelo build ou adotando a versão da produção.
  const patterns = ignorePatternsFor(repo);
  const ignored = matchIgnored(files, patterns);
  const sourceFiles = files.filter((f) => !ignored.includes(f));
  if (ignored.length) {
    console.log(
      `\n↷ ${ignored.length} arquivo(s) ignorado(s), não resolvidos pela IA: ${ignored.join(', ')}`,
    );
  }

  if (sourceFiles.length) {
    let resolved;
    try {
      resolved = resolveProvider(preferred);
    } catch (e) {
      console.error(`⚠ Resolução por IA indisponível: ${e.message}`);
      return false;
    }
    if (!resolved) return false;

    console.log(
      `\n🤖 Gerando propostas de resolução com IA (${resolved.provider.label})… ` +
        'isso pode levar alguns segundos por arquivo.',
    );

    for (const file of sourceFiles) {
      // Feedback por arquivo: sem isto, a chamada à IA parece "travada".
      console.log(`\n→ Analisando "${file}" com IA…`);
      let proposed;
      try {
        proposed = resolveConflictFile({
          cwd,
          production,
          branch,
          file,
          provider: resolved.provider,
        });
      } catch (e) {
        // Arquivo grande demais ou resposta inválida: não trava o fluxo —
        // avisa, pula para o próximo e deixa este para resolução manual.
        console.error(
          `  ⚠ sem proposta automática (${e.message}). "${file}" continua em conflito para resolução manual.`,
        );
        continue;
      }

      const width = 60;
      console.log(`\n┌─ Proposta para ${file} ${'─'.repeat(Math.max(0, width - 18 - file.length))}`);
      console.log('│ Por que resolver assim:');
      const rationale = proposed.rationale || '(o provedor não explicou a escolha)';
      for (const line of wrapText(rationale, width - 2)) console.log(`│   ${line}`);
      console.log(`├─ Alterações propostas ${'─'.repeat(Math.max(0, width - 23))}`);
      printProposalDiff(cwd, file, proposed.content);
      console.log(`└${'─'.repeat(width)}`);

      const apply = await confirm({
        message: `Aplicar a resolução proposta em "${file}"?`,
        default: false,
      });
      if (!apply) {
        console.log(`  ↷ descartada — "${file}" continua em conflito.`);
        continue;
      }
      writeFileSync(join(cwd, file), proposed.content);
      git(cwd, ['add', '--', file]);
      console.log(`  ✔ aplicada — "${file}" resolvido e adicionado ao índice.`);
    }
  }

  // Só restam conflitos "de verdade" (não-ignorados)? Pausa para resolução manual.
  const remaining = conflictedFiles(cwd);
  const remIgnored = matchIgnored(remaining, patterns);
  const remSource = remaining.filter((f) => !remIgnored.includes(f));
  if (remSource.length) {
    console.error(
      `\n⏸  ${remSource.length} arquivo(s) sem resolução automática — ` +
        'resolva-os manualmente antes de prosseguir:',
    );
    for (const f of remSource) console.error(`     - ${f}`);
    return false;
  }

  // Restam apenas arquivos ignorados: trata-os e conclui o merge.
  if (remIgnored.length) {
    return finalizeIgnoredFiles(cwd, production, branch, repo);
  }

  // --cleanup=strip remove as linhas de comentário `# Conflicts:` que o git
  // acrescenta ao MERGE_MSG durante o conflito (--no-edit usa cleanup
  // `whitespace`, que as manteria literais na mensagem do commit).
  const commit = tryGit(cwd, ['commit', '--no-edit', '--cleanup=strip']);
  if (!commit.ok) {
    console.error(
      `✖ Todos os conflitos foram resolvidos, mas o commit do merge falhou:\n${commit.out}`,
    );
    return false;
  }
  console.log(`\n✔ Conflitos resolvidos; merge de "${production}" em "${branch}" concluído.`);
  return true;
}

// Conclui o merge quando os ÚNICOS conflitos restantes são arquivos ignorados:
// se há comando de build, roda o build (que os regera, apagando os marcadores);
// senão, adota a versão da produção (`git checkout --theirs`). Depois adiciona e
// commita. Retorna true se o merge foi concluído; false (sem lançar) se não se
// aplica (há conflito não-ignorado, nenhum ignorado, ou o build falhou).
export function finalizeIgnoredFiles(cwd, production, branch, repo) {
  const patterns = ignorePatternsFor(repo);
  if (!patterns.length) return false;
  const remaining = conflictedFiles(cwd);
  const ignored = matchIgnored(remaining, patterns);
  const other = remaining.filter((f) => !ignored.includes(f));
  if (other.length || !ignored.length) return false;

  const buildCmd = repo?.build?.command;
  if (buildCmd) {
    console.log(
      `\n🔧 Regenerando ${ignored.length} arquivo(s) ignorado(s) via "${buildCmd}"…`,
    );
    const r = runBuild(cwd, buildCmd);
    if (!r.ok) {
      console.error(
        `\n⚠ O build falhou (código ${r.code}). Resolva manualmente: ${ignored.join(', ')}`,
      );
      return false;
    }
    // O build regera os arquivos; adiciona tudo (a árvore só tem mudanças do merge).
    git(cwd, ['add', '-A']);
  } else {
    // Sem build: adota a versão da produção para os arquivos ignorados.
    console.log(
      `\n↷ ${ignored.length} arquivo(s) ignorado(s) resolvidos com a versão de "${production}": ${ignored.join(', ')}`,
    );
    git(cwd, ['checkout', '--theirs', '--', ...ignored]);
    git(cwd, ['add', '--', ...ignored]);
  }

  const still = conflictedFiles(cwd);
  if (still.length) {
    console.error(`\n⚠ Ainda há conflito não resolvido em: ${still.join(', ')}`);
    return false;
  }

  // --cleanup=strip: ver nota em runConflictResolution (remove `# Conflicts:`).
  const commit = tryGit(cwd, ['commit', '--no-edit', '--cleanup=strip']);
  if (!commit.ok) {
    console.error(
      `✖ Arquivos ignorados tratados, mas o commit do merge falhou:\n${commit.out}`,
    );
    return false;
  }
  console.log(
    `\n✔ Merge de "${production}" em "${branch}" concluído (arquivos ignorados tratados automaticamente).`,
  );
  return true;
}

// Quebra texto em linhas de até `width` colunas, preservando parágrafos.
// Deixa a justificativa da IA legível no terminal sem depender do wrap do TTY.
function wrapText(text, width) {
  const out = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      if (!word) continue;
      if (line && line.length + 1 + word.length > width) {
        out.push(line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    out.push(line);
  }
  return out.length ? out : [''];
}

// Mostra o diff entre o arquivo em conflito e a proposta da IA.
function printProposalDiff(cwd, file, proposed) {
  const dir = mkdtempSync(join(tmpdir(), 'branch-sync-resolve-'));
  try {
    const tmp = join(dir, basename(file));
    writeFileSync(tmp, proposed);
    // --no-index sai com código != 0 quando há diferenças; por isso tryGit.
    const d = tryGit(cwd, ['diff', '--no-index', '--color', '--', file, tmp]);
    console.log(d.out || '(a proposta é idêntica ao arquivo atual)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function renderMessage(template, branch, prod) {
  const rendered = template
    .replaceAll('{branch}', branch)
    .replaceAll('{prod}', prod);
  // `git merge -m` não remove linhas de comentário como o editor faria; um
  // template com linhas `#` as levaria literais para o commit. Removemos as
  // linhas cujo primeiro caractere é `#` (comentário) e colapsamos as vazias
  // resultantes nas bordas, imitando o cleanup padrão do git.
  return rendered
    .split('\n')
    .filter((line) => !line.startsWith('#'))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function processQueue(
  repo,
  production,
  queue,
  completed,
  { updateProduction, push, fetch, message, explain, ai, resolve },
) {
  const cwd = repo.path;

  if (!branchExists(cwd, production)) {
    console.error(`✖ A branch de produção "${production}" não existe em "${repo.name}".`);
    process.exit(1);
  }

  if (!isClean(cwd)) {
    console.error(
      `✖ "${repo.name}" tem alterações não commitadas (${currentBranch(cwd)}). ` +
        'Faça commit ou stash antes de sincronizar.',
    );
    process.exit(1);
  }

  // Busca os refs do remoto uma vez por execução.
  if (fetch) {
    console.log('↻ git fetch…');
    const f = tryGit(cwd, ['fetch', '--all', '--quiet']);
    if (!f.ok) {
      console.warn(
        `⚠ fetch falhou (seguindo com refs locais):\n${f.out || '(sem detalhes)'}`,
      );
    }
  }

  // Atualiza a branch de produção a partir do remoto (apenas no início).
  if (updateProduction) {
    git(cwd, ['checkout', production]);
    if (hasUpstream(cwd, production)) {
      console.log(`↻ Atualizando "${production}" a partir do remoto…`);
      // Com fetch já feito, basta avançar; sem fetch, faz o pull.
      const up = upstreamRef(cwd, production);
      const r = fetch
        ? tryGit(cwd, ['merge', '--ff-only', up])
        : tryGit(cwd, ['pull', '--ff-only']);
      if (!r.ok) {
        console.error(
          `✖ Não foi possível avançar "${production}" para o remoto (divergiu?):\n${r.out}`,
        );
        process.exit(1);
      }
    }
  }

  while (queue.length) {
    const branch = queue[0];

    if (!branchExists(cwd, branch)) {
      console.warn(`⚠ Branch "${branch}" não existe mais — pulando.`);
      queue.shift();
      continue;
    }

    console.log(`\n→ ${branch}  ⬅  ${production}`);
    git(cwd, ['checkout', branch]);

    // Sincroniza a branch com seu upstream antes de mesclar (fast-forward).
    if (fetch && hasUpstream(cwd, branch)) {
      const up = upstreamRef(cwd, branch);
      const ff = tryGit(cwd, ['merge', '--ff-only', up]);
      if (!ff.ok) {
        // Não dá para avançar: a branch local divergiu do remoto.
        console.error(
          `\n✖ "${branch}" divergiu de "${up}" (há commits locais e remotos distintos).\n` +
            `   Reconcilie manualmente (git pull --rebase, ou merge) e rode "branch-sync update" de novo.\n` +
            `   Branches já concluídas nesta execução: ${completed.length ? completed.join(', ') : '(nenhuma)'} — serão refeitas (no-op) na re-execução.`,
        );
        process.exit(1);
      }
      if (!ff.out.includes('Already up to date')) {
        console.log(`  ↻ avançada para ${up}`);
      }
    }

    const mergeArgs = message
      ? ['merge', '-m', renderMessage(message, branch, production), production]
      : ['merge', '--no-edit', production];
    const res = tryGit(cwd, mergeArgs);

    if (res.ok) {
      console.log(`  ✔ ${res.out.includes('Already up to date') ? 'já atualizada' : 'mesclada'}`);
      completed.push(branch);
      queue.shift();
      continue;
    }

    // Falhou. Se há um merge em andamento, é conflito → pausa e persiste o estado.
    if (mergeInProgress(cwd)) {
      const remaining = queue.slice(1);
      // Persiste o estado ANTES de tentar a resolução por IA: se o usuário
      // cancelar no meio (Ctrl+C), a retomada continua funcionando.
      saveState({
        repo: repo.name,
        production,
        current: branch,
        pending: remaining,
        completed,
        push,
        fetch,
        message,
        explain,
        ai,
        resolve,
      });

      const files = conflictedFiles(cwd);
      // Arquivos ignorados (ex.: *.map) não entram na análise/resolução por IA.
      const sourceFiles = files.filter((f) => !matchIgnored(files, ignorePatternsFor(repo)).includes(f));
      console.error(`\n⏸  Conflito ao mesclar "${production}" em "${branch}".`);
      if (files.length) {
        console.error('   Arquivos em conflito:');
        for (const f of files) console.error(`     - ${f}`);
      }
      if (explain && sourceFiles.length) {
        runConflictExplanation(cwd, production, branch, sourceFiles, ai);
      }
      if (resolve) {
        const merged = await runConflictResolution(cwd, production, branch, files, ai, repo);
        if (merged) {
          completed.push(branch);
          queue.shift();
          continue;
        }
      } else if (finalizeIgnoredFiles(cwd, production, branch, repo)) {
        // Sem --resolve: se o conflito é só de arquivos ignorados, trata-os
        // (build ou versão da produção) e conclui — sem intervenção manual.
        completed.push(branch);
        queue.shift();
        continue;
      }
      console.error(
        '\n   Resolva os conflitos, então:\n' +
          '     git add <arquivos> && git commit   (ou git merge --continue)\n' +
          '   e rode "branch-sync update" novamente para continuar de onde parou.',
      );
      if (remaining.length) {
        console.error(`   Branches restantes após esta: ${remaining.join(', ')}`);
      }
      console.error('');
      process.exit(1);
    }

    // Outro tipo de falha (ex.: merge abortado automaticamente).
    console.error(`\n✖ Falha ao mesclar em "${branch}":\n${res.out}`);
    process.exit(1);
  }

  clearState();
  console.log(
    `\n✅ "${repo.name}" sincronizado. ${completed.length} branch(es) atualizada(s): ${completed.join(', ')}`,
  );

  // ---- Push ao final (apenas branches com upstream configurado) ----
  if (push) {
    const pushed = [];
    const skipped = [];
    for (const b of completed) {
      const up = upstreamRef(cwd, b);
      if (!up) {
        skipped.push(b);
        continue;
      }
      const sep = up.indexOf('/');
      const remote = up.slice(0, sep);
      const remoteBranch = up.slice(sep + 1);
      console.log(`↑ push ${b} → ${up}`);
      const r = tryGit(cwd, ['push', remote, `${b}:${remoteBranch}`]);
      if (!r.ok) {
        console.error(
          `\n✖ push de "${b}" falhou:\n${r.out}\n` +
            `   Os merges locais estão preservados. Resolva e rode "branch-sync update" de novo (re-tenta o push).`,
        );
        process.exit(1);
      }
      pushed.push(b);
    }
    if (pushed.length) console.log(`↑ ${pushed.length} branch(es) enviada(s): ${pushed.join(', ')}`);
    if (skipped.length)
      console.log(`↷ sem upstream, não enviada(s): ${skipped.join(', ')}`);
  } else {
    console.log('↷ push desativado (--no-push). Os merges ficaram apenas locais.');
  }
  console.log('');
}
