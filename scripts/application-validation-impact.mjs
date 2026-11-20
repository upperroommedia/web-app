import { execFileSync } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { groupNames } from './validate-application-parallel.mjs';

// Historical reports and architecture records have no build/test consumers.
// Restrict the exception to regular prose files. Renames, additions, deletions,
// mode changes and any other path take the full path.
const prose =
  /^docs\/(?:adr\/[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9-]+|PERFORMANCE_SWEEP_2026-02-23|WEB_FIRST_LOAD_2026-10-01|process-audio-staging-debug-2026-03-25)\.md$/;
export function proseOnlyDiff(raw) {
  const fields = raw.split('\0');
  if (fields.pop() !== '' || fields.length === 0 || fields.length % 2) return false;
  for (let i = 0; i < fields.length; i += 2) {
    if (!/^:100644 100644 [0-9a-f]{40} [0-9a-f]{40} M$/.test(fields[i]) || !prose.test(fields[i + 1])) return false;
  }
  return true;
}

export function validationMode(eventName, pr, commit, cwd) {
  if (eventName !== 'pull_request' || !pr?.base?.ref || ['staging', 'main'].includes(pr.base.ref)) return 'full';
  const base = pr.base.sha,
    head = pr.head?.sha;
  if (![base, head, commit].every((id) => /^[a-f0-9]{40}$/.test(id ?? ''))) return 'full';
  const git = (...args) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 4 * 1024 * 1024,
    });
  try {
    if (
      git('rev-parse', '--is-shallow-repository').trim() !== 'false' ||
      git('rev-parse', 'HEAD').trim() !== commit ||
      git('show', '-s', '--format=%P', commit).trim() !== base + ' ' + head
    )
      return 'full';
    const ancestor = git('merge-base', '--all', base, head).trim();
    if (!/^[a-f0-9]{40}$/.test(ancestor)) return 'full';
    const diff = (a, b) =>
      git(
        'diff',
        '--raw',
        '-z',
        '--no-abbrev',
        '--no-renames',
        '--no-ext-diff',
        '--no-textconv',
        '--ignore-submodules=none',
        a,
        b,
        '--'
      );
    // Check both what the PR authored and what GitHub's actual merge will apply.
    if (proseOnlyDiff(diff(ancestor, head)) && proseOnlyDiff(diff(base, commit))) return 'prose';
  } catch {
    // Missing commits, oversized output or git errors cannot suppress validation.
  }
  return 'full';
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const mode = validationMode(process.env.GITHUB_EVENT_NAME, event.pull_request, process.env.GITHUB_SHA);
  await appendFile(process.env.GITHUB_OUTPUT, 'mode=' + mode + '\ngroups=' + JSON.stringify(groupNames) + '\n');
  console.log(mode === 'full' ? 'Running complete application validation.' : 'Only independent prose changed.');
}
