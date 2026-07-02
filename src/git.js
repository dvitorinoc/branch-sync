import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// Executa um comando git; lança erro em caso de status != 0.
export function git(cwd, args, opts = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  }).trim();
}

// Executa um comando git sem lançar; retorna { ok, out, code }.
export function tryGit(cwd, args) {
  try {
    return { ok: true, out: git(cwd, args), code: 0 };
  } catch (e) {
    return {
      ok: false,
      out: `${e.stdout || ''}${e.stderr || ''}`.trim(),
      code: e.status ?? 1,
    };
  }
}

export function isGitRepo(path) {
  return (
    existsSync(join(path, '.git')) ||
    tryGit(path, ['rev-parse', '--is-inside-work-tree']).ok
  );
}

export function currentBranch(cwd) {
  return git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
}

export function isClean(cwd) {
  return git(cwd, ['status', '--porcelain']) === '';
}

export function mergeInProgress(cwd) {
  return tryGit(cwd, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).ok;
}

export function branchExists(cwd, branch) {
  return tryGit(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
    .ok;
}

export function hasUpstream(cwd, branch) {
  return tryGit(cwd, ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`]).ok;
}

// Retorna o upstream configurado de uma branch (ex.: "origin/feature/x") ou null.
export function upstreamRef(cwd, branch) {
  const r = tryGit(cwd, ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`]);
  return r.ok ? r.out : null;
}

// Lista os branches locais.
export function localBranches(cwd) {
  const out = git(cwd, ['branch', '--format=%(refname:short)']);
  return out ? out.split('\n').map((b) => b.trim()).filter(Boolean) : [];
}

// Arquivos com conflito não resolvido.
export function conflictedFiles(cwd) {
  const out = git(cwd, ['diff', '--name-only', '--diff-filter=U']);
  return out ? out.split('\n').filter(Boolean) : [];
}
