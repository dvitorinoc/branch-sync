# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## O que é

CLI (`branch-sync` / alias `bsync`) que mescla a branch de produção de um repositório
em uma lista de branches monitoradas, **pausando em conflitos e retomando** após a
resolução. Suporta múltiplos repositórios, cada um com sua própria lista de branches.

## Comandos

```bash
npm install                 # dependências (commander, @inquirer/prompts)
node bin/cli.js <args>       # rodar localmente sem instalar
npm install -g .             # instala os binários globais branch-sync / bsync
npm link                     # alternativa para desenvolvimento
```

Após editar o código, é preciso **`npm install -g .` de novo** para o binário global
refletir as mudanças (o global copia os arquivos, não usa symlink — exceto via `npm link`).

**Não há suíte de testes nem linter configurados.** A verificação é manual: criar um
repositório git temporário e apontar o `BRANCH_SYNC_DIR` para um diretório descartável,
isolando a config real do usuário:

```bash
export BRANCH_SYNC_DIR=/tmp/cfg          # isola config.json/state.json
# montar um repo git de teste, semear $BRANCH_SYNC_DIR/config.json e rodar:
node bin/cli.js update <repo>
```

Cenários que sempre valem a pena cobrir ao mexer no `update`: merge sem conflito,
conflito (pausa) → resolução → retomada, branch local atrás do remoto (fast-forward),
divergência (deve abortar antes de mesclar), `--no-fetch`, `--no-push`, push sem upstream,
`--resolve` (aceitar e recusar a proposta; um CLI `claude` falso no PATH serve de provedor).

## Arquitetura

ESM (`"type": "module"`). Camadas:

- `bin/cli.js` — definição dos comandos com **commander** e tratamento de `ExitPromptError`
  (Ctrl+C nos prompts). Único ponto de parsing de argumentos.
- `src/config.js` — **persistência**. Toda I/O de arquivo passa por aqui. Define a
  localização da config (`~/.config/branch-sync/`, sobrescrevível por `BRANCH_SYNC_DIR`).
- `src/git.js` — **wrappers de git** via `execFileSync`. `git()` lança em erro; `tryGit()`
  retorna `{ ok, out, code }` para fluxos que precisam inspecionar a falha (conflito, push
  rejeitado, divergência). Nenhum outro módulo deve chamar `execFileSync` diretamente.
- `src/ignore.js` — **casamento de arquivos ignorados**. `matchIgnored(files, patterns)`
  casa caminhos no estilo `.gitignore` (padrão sem barra casa o nome em qualquer pasta;
  com barra é ancorado na raiz; `*`/`**`/`?`/barra final). Define quais arquivos em
  conflito **não** devem ser resolvidos (ex.: `*.map`, `include/build/*`).
- `src/build.js` — `runBuild(cwd, command)` roda o comando de build do repo com a saída
  ao vivo, usado para regerar os arquivos ignorados — ver o núcleo do `update`.
- `src/commands/{repo,branch,update,explain}.js` — lógica de cada comando. `repo.js`
  exporta `resolveRepo()`, reutilizado pelos demais para resolver o repositório por
  argumento ou por prompt de seleção. `explain.js` reusa `runConflictExplanation()`
  exportado por `update.js`.
- `src/ai.js` — **análise e resolução de conflitos por IA** (opcional). Invoca os CLIs
  `claude` (`claude -p`) e `codex` (`codex exec -o <arquivo> -`) de forma não-interativa,
  com o conteúdo do conflito embutido no prompt (o modelo não acessa arquivos).
  `resolveProvider` faz auto-detecção via `--version` (ENOENT = ausente). Além da
  explicação (`explainConflicts`), `resolveConflictFile` pede ao modelo — numa única
  resposta — uma **justificativa** e o conteúdo completo do arquivo resolvido, separados
  por um marcador sentinela (`RESOLVE_SENTINEL`); retorna `{ content, rationale }` e valida
  (marcador presente, resposta não-vazia, sem marcadores de conflito, cerca de código
  removida). A proposta **só é aplicada após confirmação do usuário**, no chamador, que
  exibe a justificativa (com `wrapText`) e o diff antes de perguntar.
  Toda falha é tratada como opcional: a IA **nunca** deve interromper o fluxo de
  resolução — os chamadores (`runConflictExplanation`/`runConflictResolution`) capturam
  erros e só emitem aviso, deixando o arquivo em conflito para resolução manual.

### Decisão de armazenamento

Tudo num **único `config.json`**: array `repositories`, cada um com `{ name, path,
mainBranch, branches[] }`, um `ignore[]` opcional (padrões de arquivos a não resolver) e
um `build` opcional `{ command }`. A lista de branches fica aninhada no repositório (não em
arquivos separados) — os dados são pequenos e isso mantém add/remove como uma única
leitura+escrita atômica. Ver README para o racional completo.
(Compat: `build.artifacts[]` legado ainda é lido como padrões de ignore, via
`ignorePatternsFor`.)

### O núcleo: máquina de estados retomável do `update`

Esta é a parte com mais nuance — leia `src/commands/update.js` inteiro antes de alterar.

`update` processa as branches em fila. Em **conflito de merge**, ele grava
`state.json` (`{ repo, production, current, pending[], completed[], push, fetch, message }`)
e sai com código 1. Na execução seguinte, `updateCommand` detecta o `state.json`:

- Se ainda há merge em andamento (`MERGE_HEAD` existe) → recusa e instrui a resolver.
- Se o merge foi resolvido/commitado → trata `current` como concluída e **retoma a fila
  por `pending`**, sem refazer as de `completed`.

Pontos sutis a preservar:

- **Flags são persistidas no estado** (`push`, `fetch`, `message`, `explain`, `ai`,
  `resolve`) para a retomada aplicar as mesmas escolhas às branches restantes — não
  dependa de o usuário repetir as flags. `--explain`/`--ai <provedor>` liga a análise
  por IA; `--ai` sozinho já implica `--explain` (a lógica está em `updateCommand`, não
  em commander). `--resolve` liga a resolução assistida (proposta + confirmação por
  arquivo); passá-la **na retomada** também funciona e persiste a escolha. O estado é
  salvo **antes** de tentar a resolução por IA — Ctrl+C num prompt de confirmação não
  quebra a retomada. Se a resolução completa o merge, a fila **continua na mesma
  execução** (o `state.json` fica momentaneamente defasado, mas com semântica correta
  para retomada; ele é regravado no próximo conflito ou limpo ao final).
- Ordem dentro do loop, **por branch**: checkout → (se `fetch` e tem upstream)
  `merge --ff-only @{upstream}` para sincronizar com o remoto → merge da produção.
  A divergência real (ff-only falha) **aborta antes de mesclar**, sem salvar estado
  (re-rodar refaz as concluídas como no-op).
- **Push é por último**, só ao esvaziar a fila, e só de branches com upstream. Acontece
  *depois* de `clearState()`, então uma falha de push não corrompe o estado de retomada.
- **Arquivos ignorados** (`repo.ignore`, casados por `matchIgnored`): arquivos gerados
  (ex.: `*.map`) **não são resolvidos** — a IA nunca os recebe (`runConflictResolution` e a
  análise os excluem via `ignorePatternsFor`). Depois que os conflitos "de verdade" somem,
  `finalizeIgnoredFiles()` conclui o merge: se há `build.command`, roda o build (regera os
  arquivos) e faz `git add -A`; senão, adota a versão da **produção** (`git checkout
  --theirs`) para eles. É chamado em três pontos: no fim de `runConflictResolution`, no
  fluxo **sem `--resolve`** (conflito só de ignorados → conclui sozinho) e na **retomada**.
  Retorna `false` sem efeito colateral se ainda há conflito não-ignorado, se não há ignorado,
  ou se o build falha (aí pausa para resolução manual). Não faz nada sem padrões de ignore.
- `--abort` apenas limpa `state.json`; não desfaz merges no repositório.

As mensagens ao usuário são em **português** — mantenha o idioma ao adicionar saídas.
