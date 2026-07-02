import { execFileSync } from 'node:child_process';
import { readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Análise de conflitos de merge por IA, usando os CLIs `claude` e `codex`.
//
// Cada provedor é invocado de forma NÃO-interativa, com o conteúdo do conflito
// embutido no prompt (o modelo não precisa acessar arquivos). O resultado é um
// texto explicativo em português. Qualquer falha aqui é tratada como opcional:
// a análise nunca deve impedir o fluxo normal de resolução de conflitos.

const TIMEOUT_MS = 120000; // IA pode demorar; 2 min é um teto generoso.
const MAX_FILE_CHARS = 4000; // trecho por arquivo enviado ao modelo.
const MAX_TOTAL_CHARS = 16000; // teto do prompt inteiro.
const CONTEXT_LINES = 3; // linhas de contexto ao redor de cada conflito.
const MAX_RESOLVE_CHARS = 48000; // teto do arquivo inteiro no prompt de resolução.

const PROVIDERS = {
  claude: {
    label: 'Claude',
    run(prompt, cwd) {
      return execFileSync('claude', ['-p', '--output-format', 'text'], {
        cwd,
        input: prompt,
        encoding: 'utf8',
        timeout: TIMEOUT_MS,
        // SIGKILL (não o SIGTERM padrão): garante que o CLI seja de fato
        // encerrado no timeout, evitando que o processo fique travado.
        killSignal: 'SIGKILL',
        maxBuffer: 10 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    },
  },
  codex: {
    label: 'Codex',
    run(prompt, cwd) {
      const outFile = join(tmpdir(), `branch-sync-ai-${process.pid}-${Date.now()}.txt`);
      try {
        execFileSync(
          'codex',
          [
            'exec',
            '--sandbox', 'read-only',
            '--color', 'never',
            '--skip-git-repo-check',
            '-o', outFile,
            '-', // lê o prompt do stdin
          ],
          {
            cwd,
            input: prompt,
            encoding: 'utf8',
            timeout: TIMEOUT_MS,
            // SIGKILL (não o SIGTERM padrão): garante que o CLI seja de fato
            // encerrado no timeout, evitando que o processo fique travado.
            killSignal: 'SIGKILL',
            maxBuffer: 10 * 1024 * 1024,
            stdio: ['pipe', 'ignore', 'pipe'],
          },
        );
        return readFileSync(outFile, 'utf8').trim();
      } finally {
        try {
          unlinkSync(outFile);
        } catch {
          /* arquivo temporário pode não existir */
        }
      }
    },
  },
};

export const AI_PROVIDERS = Object.keys(PROVIDERS);

// Um CLI está disponível se roda `--version` sem erro de "não encontrado".
function isAvailable(cmd) {
  try {
    execFileSync(cmd, ['--version'], { stdio: 'ignore', timeout: 10000 });
    return true;
  } catch (e) {
    // Instalado mas com saída != 0 ainda conta como disponível; só ENOENT não.
    return e.code !== 'ENOENT';
  }
}

// Resolve qual provedor usar. `preferred`: 'claude' | 'codex' | 'auto' | 'off'.
// Retorna { key, provider } ou lança um Error com mensagem amigável.
export function resolveProvider(preferred = 'auto') {
  if (preferred === 'off') return null;

  if (preferred && preferred !== 'auto') {
    if (!PROVIDERS[preferred]) {
      throw new Error(
        `Provedor de IA desconhecido: "${preferred}". Use: ${AI_PROVIDERS.join(', ')} ou auto.`,
      );
    }
    if (!isAvailable(preferred)) {
      throw new Error(
        `O CLI "${preferred}" não está instalado ou não está no PATH.`,
      );
    }
    return { key: preferred, provider: PROVIDERS[preferred] };
  }

  // auto: usa o primeiro CLI disponível, na ordem de AI_PROVIDERS.
  for (const key of AI_PROVIDERS) {
    if (isAvailable(key)) return { key, provider: PROVIDERS[key] };
  }
  throw new Error(
    `Nenhum CLI de IA encontrado no PATH (procurei: ${AI_PROVIDERS.join(', ')}).`,
  );
}

// Extrai os trechos em conflito de um arquivo (regiões entre <<<<<<< e >>>>>>>),
// com algumas linhas de contexto, limitando o tamanho total.
function extractConflictSnippet(content) {
  const lines = content.split('\n');
  const parts = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].startsWith('<<<<<<<')) {
      let end = i;
      while (end < lines.length && !lines[end].startsWith('>>>>>>>')) end++;
      const from = Math.max(0, i - CONTEXT_LINES);
      const to = Math.min(lines.length - 1, end + CONTEXT_LINES);
      parts.push(lines.slice(from, to + 1).join('\n'));
      i = end + 1;
    } else {
      i++;
    }
  }
  let snippet = parts.length ? parts.join('\n...\n') : content;
  if (snippet.length > MAX_FILE_CHARS) {
    snippet = snippet.slice(0, MAX_FILE_CHARS) + '\n… (truncado)';
  }
  return snippet;
}

// Monta o prompt em português com o contexto do merge e os conflitos.
function buildPrompt(cwd, production, branch, files) {
  const blocks = [];
  let total = 0;
  for (const f of files) {
    let snippet;
    try {
      snippet = extractConflictSnippet(readFileSync(join(cwd, f), 'utf8'));
    } catch {
      snippet = '(não foi possível ler o arquivo)';
    }
    const block = `=== arquivo: ${f} ===\n${snippet}`;
    if (total + block.length > MAX_TOTAL_CHARS) {
      blocks.push(`=== arquivo: ${f} ===\n(omitido: limite de tamanho atingido)`);
      break;
    }
    blocks.push(block);
    total += block.length;
  }

  return [
    'Você é um assistente especialista em git que explica conflitos de merge de forma clara e objetiva. Responda SEMPRE em português do Brasil.',
    '',
    `Estou mesclando a branch de produção "${production}" na branch "${branch}". Houve conflito nos arquivos abaixo, mostrados com os marcadores <<<<<<<, ======= e >>>>>>>.`,
    '',
    'Para cada arquivo em conflito, explique de forma concisa:',
    '1. O que o lado da branch (HEAD/<<<<<<<, o destino do merge) e o lado da produção (>>>>>>>) estão tentando mudar.',
    '2. Por que os dois lados conflitam.',
    '3. Uma sugestão de como resolver (qual lado manter, ou como combinar).',
    '',
    'Não execute comandos nem modifique arquivos — apenas explique. Use texto simples, sem blocos de código longos.',
    '',
    ...blocks,
  ].join('\n');
}

// Executa a análise de conflitos e retorna { label, text }.
// Lança se o provedor não estiver disponível ou se a execução falhar.
export function explainConflicts({ cwd, production, branch, files, preferred = 'auto' }) {
  const resolved = resolveProvider(preferred);
  if (!resolved) return null;
  const { provider } = resolved;
  const prompt = buildPrompt(cwd, production, branch, files);
  const text = provider.run(prompt, cwd);
  return { label: provider.label, text };
}

// Separa a justificativa do conteúdo do arquivo na resposta de resolução.
// Escolhido para ser distinto e improvável de aparecer em código real.
const RESOLVE_SENTINEL = '===branch-sync:arquivo-resolvido===';

// Monta o prompt que pede ao modelo a JUSTIFICATIVA e, após um marcador, o
// conteúdo completo do arquivo resolvido — as duas coisas na mesma resposta,
// para a explicação corresponder exatamente à resolução proposta.
function buildResolvePrompt(production, branch, file, content) {
  return [
    'Você é um assistente especialista em git que resolve conflitos de merge.',
    '',
    `Estou mesclando a branch de produção "${production}" na branch "${branch}". O arquivo "${file}" ficou em conflito. No conteúdo abaixo, o lado "<<<<<<< HEAD" é a branch "${branch}" (o destino do merge) e o lado ">>>>>>>" é a produção "${production}".`,
    '',
    'Sua resposta deve ter DUAS partes, exatamente nesta ordem:',
    '',
    '1. Uma explicação curta (2 a 4 frases), em português do Brasil, de POR QUE esta é a melhor forma de resolver o conflito: o que cada lado queria e por que você manteve, combinou ou descartou cada parte.',
    `2. Uma linha contendo APENAS o marcador literal:`,
    `   ${RESOLVE_SENTINEL}`,
    '3. Logo após o marcador, o CONTEÚDO COMPLETO do arquivo já resolvido, do início ao fim.',
    '',
    'Regras para o conteúdo resolvido (parte 3):',
    '- Remova todos os marcadores de conflito (<<<<<<<, ======= e >>>>>>>).',
    '- Combine a intenção dos dois lados quando fizer sentido; não descarte mudanças de nenhum lado sem necessidade.',
    '- Não altere nada fora das regiões em conflito.',
    '- Depois do marcador, escreva SOMENTE o conteúdo do arquivo — sem comentários adicionais e sem cercas de código (```).',
    '',
    `=== arquivo em conflito: ${file} ===`,
    content,
  ].join('\n');
}

// Remove uma cerca de código (```), caso o modelo tenha embrulhado a resposta.
function stripCodeFence(text) {
  const m = text.match(/^\s*```[^\n]*\n([\s\S]*?)\n?```\s*$/);
  return m ? m[1] : text;
}

// Pede ao modelo a resolução completa de UM arquivo em conflito e retorna
// { content, rationale }: o conteúdo proposto e a justificativa da escolha.
// Recebe o `provider` já resolvido (via resolveProvider), para não re-detectar
// o CLI a cada arquivo. Lança em qualquer falha; o chamador decide o que fazer
// — a proposta nunca é aplicada sem confirmação do usuário.
export function resolveConflictFile({ cwd, production, branch, file, provider }) {
  const content = readFileSync(join(cwd, file), 'utf8');
  if (content.length > MAX_RESOLVE_CHARS) {
    throw new Error(
      `arquivo muito grande para resolução por IA (${content.length} caracteres; limite ${MAX_RESOLVE_CHARS})`,
    );
  }
  const raw = provider.run(buildResolvePrompt(production, branch, file, content), cwd);

  // A resposta é "justificativa + marcador + conteúdo". Sem o marcador não dá
  // para separar com segurança o texto do arquivo → trata como falha (manual).
  const idx = raw.indexOf(RESOLVE_SENTINEL);
  if (idx === -1) {
    throw new Error('a resposta não seguiu o formato esperado (marcador ausente)');
  }
  const rationale = raw.slice(0, idx).trim();
  let proposed = stripCodeFence(
    raw.slice(idx + RESOLVE_SENTINEL.length).replace(/^\r?\n/, ''),
  );
  if (!proposed.trim()) throw new Error('o modelo retornou um arquivo vazio');
  if (/^(<{7}|>{7})/m.test(proposed)) {
    throw new Error('a proposta ainda contém marcadores de conflito');
  }
  if (!proposed.endsWith('\n')) proposed += '\n';
  return { content: proposed, rationale };
}
