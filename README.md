# branch-sync

CLI para atualizar uma lista de branches com a branch de produção de um
repositório. **Pausa quando há conflito** e **retoma de onde parou** assim que
você resolve. Suporta múltiplos repositórios, cada um com sua própria lista de
branches, tudo persistido em arquivo de configuração JSON.

## Instalação

Requer **Node.js >= 18**. Instale global a partir do npm:

```bash
npm install -g branch-sync
```

Isso instala **dois** comandos equivalentes no PATH: `branch-sync` e o alias
curto `bsync`. Para conferir:

```bash
bsync --version
```

### A partir do código-fonte

Para desenvolvimento ou para instalar de um clone local:

```bash
cd branch-sync
npm install               # instala as dependências
npm install -g .          # disponibiliza os binários globais (branch-sync e bsync)
```

Atalhos de `npm scripts` (equivalentes aos comandos acima):

```bash
npm run install:global    # = npm install -g .
npm run link:dev          # = npm link  (symlink para desenvolvimento)
```

> **Nota:** `npm install -g .` **copia** os arquivos. Ao editar o código, rode
> `npm install -g .` de novo para o binário global refletir a mudança. Para
> desenvolvimento contínuo, prefira `npm link` (`npm run link:dev`), que usa um
> symlink e dispensa reinstalar a cada alteração.

Sem instalar globalmente, dá para rodar direto do repositório:

```bash
node bin/cli.js <args>    # ou: npm start -- <args>
```

### Atualizar

```bash
npm update -g branch-sync         # respeita o range instalado
npm install -g branch-sync@latest # força a última versão publicada
```

Quando há uma versão nova no npm, o próprio CLI avisa no terminal (verificação
diária em segundo plano, via `update-notifier`). A atualização em si continua
sendo manual — os comandos acima.

### Desinstalar

```bash
npm uninstall -g branch-sync
```

## Uso

### Repositórios

```bash
bsync repo add        # pergunta caminho, nome e branch de produção
bsync repo list
bsync repo remove [nome]
```

### Branches monitoradas (vinculadas a um repositório)

```bash
bsync branch add [branch] --repo <nome>   # sem args, abre seletor
bsync branch remove [branch] --repo <nome>
bsync branch list --repo <nome>
```

Sem `--repo`, se houver mais de um repositório, um prompt de seleção é exibido.

### Atualizar

```bash
bsync update <repo>     # direto pelo nome
bsync update            # prompt para escolher o repositório
bsync update --no-fetch # não sincroniza com o remoto antes de mesclar
bsync update --no-push  # não faz push ao final (push é o padrão)
bsync update -m "chore: sync {prod} → {branch}"   # mensagem do merge
bsync update --explain  # em conflito, usa IA para explicar os conflitos
bsync update --ai codex # idem, escolhendo o provedor (implica --explain)
bsync update --resolve  # em conflito, a IA propõe a resolução e você confirma
bsync update --abort    # cancela uma sincronização em andamento
```

O `update`:

1. **`git fetch`** dos remotos e avança a branch de produção (`--ff-only`).
2. Para cada branch monitorada: faz checkout e, se ela tiver upstream,
   **sincroniza com o remoto via fast-forward** antes de mesclar. Se a branch
   **divergiu** do remoto (commits locais e remotos distintos), o comando para
   com uma mensagem clara, sem mesclar — reconcilie manualmente e rode de novo.
   Use `--no-fetch` para pular essa sincronização.
3. Mescla a branch de produção na branch monitorada. Por padrão usa a mensagem
   automática do git (`Merge branch '<prod>' into <branch>`); com
   `-m/--message` você define um template com os placeholders `{branch}` e
   `{prod}` (ex.: `-m "chore: sync {prod} → {branch}"`). A mensagem só se aplica
   quando há merge commit (não em fast-forward).
4. **Em caso de conflito**, para, lista os arquivos em conflito e salva o
   progresso. Resolva, faça `git commit` (ou `git merge --continue`) e rode
   `bsync update` de novo — ele retoma da branch seguinte sem repetir as
   já concluídas.
5. **Ao final, faz push** de cada branch atualizada — apenas das que já têm
   **upstream** configurado (as locais-only são puladas com aviso). Use
   `--no-push` para deixar os merges só locais.

As preferências `--no-fetch`/`--no-push`/`--message` são lembradas durante a
retomada após um conflito (aplicadas às branches restantes).

### Análise e resolução de conflitos por IA

Em um conflito, o branch-sync pode chamar um CLI de IA para **explicar** o que
cada lado mudou (`--explain`, nunca modifica arquivos) e/ou **propor a
resolução** de cada arquivo (`--resolve`, aplicada só com a sua confirmação).
Isso é **opcional** e depende de ter o CLI instalado:

- [`claude`](https://claude.com/claude-code) (Claude Code)
- [`codex`](https://developers.openai.com/codex/cli) (OpenAI Codex)

```bash
bsync update --explain           # liga a análise (provedor: auto)
bsync update --ai claude         # força um provedor (implica --explain)
bsync update --resolve           # propõe resoluções, confirmando arquivo a arquivo
bsync explain <repo>             # analisa o conflito atual sob demanda
bsync explain --ai codex         # …com um provedor específico
```

- `--ai` aceita `claude`, `codex` ou `auto` (usa o primeiro CLI encontrado no
  PATH, na ordem `claude`, `codex`).
- O conteúdo do conflito é enviado embutido no prompt; com `--explain` nenhum
  arquivo é alterado.
- Com `--resolve`, para **cada arquivo** em conflito a IA propõe o conteúdo
  resolvido e **explica por que** resolveu daquele jeito (o que cada lado queria
  e o que foi mantido, combinado ou descartado). A justificativa e o diff da
  proposta são exibidos e você **confirma ou recusa**. Confirmou → o arquivo é
  gravado e adicionado ao índice; recusou → ele continua em conflito para
  resolução manual. Se todos os arquivos forem resolvidos, o merge é commitado
  e a fila continua na mesma execução.
- Falhas da IA (CLI ausente, timeout, proposta inválida etc.) apenas emitem um
  aviso e **não interrompem** o fluxo — o arquivo fica para resolução manual.
- Com `--explain`/`--ai`/`--resolve` no `update`, a preferência é lembrada na
  retomada. Também dá para passar `--resolve` só na retomada: após um conflito,
  rode `bsync update --resolve` para resolvê-lo com IA.
- O comando `explain` (sem `<repo>`) usa o repositório da sincronização em
  andamento; é útil para re-rodar a análise ou trocar de provedor.

### Arquivos ignorados na resolução

Arquivos **gerados** (source maps `*.map`, bundles, `include/build/*` etc.) não
precisam ter o conflito de merge resolvido: são reconstruídos a partir do código.
Defina uma **lista de ignore** por repositório e o branch-sync não tenta
resolvê-los (a IA nunca os recebe).

```bash
bsync repo ignore '*.map' 'include/build/*'   # define a lista (substitui)
bsync repo ignore                             # edita por prompt
bsync repo ignore -r demo                     # escolhe o repo por -r/--repo
```

Também dá para configurar na criação (`bsync repo add`) ou editando o
`config.json` (campo `ignore`, veja abaixo). Os padrões seguem a semântica do
**`.gitignore`**: sem barra (`*.map`) casa pelo nome em qualquer pasta; com barra
(`include/build/*`) é ancorado na raiz; `*`/`**`/`?` e barra final também valem.

Quando restam **apenas** arquivos ignorados em conflito, o merge é concluído
automaticamente:

- Se o repositório tem um **comando de build**, ele é rodado para regerar os
  arquivos (apagando os marcadores de conflito).
- Sem comando de build, o branch-sync adota a versão da **produção** para esses
  arquivos (eles serão regenerados no próximo build do seu fluxo normal).

Isso vale **sem exigir `--resolve`** nem intervenção manual. Se há conflitos de
código junto, resolva-os (manualmente ou com `--resolve`) — os ignorados são
tratados logo em seguida, na mesma execução ou na retomada. Se o build falhar, o
branch-sync avisa e pausa para resolução manual.

## Configuração

Arquivo único em `~/.config/branch-sync/config.json` (veja com
`bsync config`). Defina `BRANCH_SYNC_DIR` para usar outro diretório.

```json
{
  "repositories": [
    {
      "name": "demo",
      "path": "/home/voce/projetos/demo",
      "mainBranch": "main",
      "branches": ["develop", "staging"],
      "ignore": ["*.map", "include/build/*"],
      "build": { "command": "npm run build" }
    }
  ]
}
```

Os campos `ignore` e `build` são **opcionais**. `ignore` lista os padrões de
arquivos que não devem ser resolvidos no conflito; `build.command`, se presente,
os regenera (senão, adota-se a versão da produção) — veja "Arquivos ignorados na
resolução" acima.

O estado de uma sincronização interrompida fica em `state.json`, no mesmo
diretório, e é removido ao concluir.
