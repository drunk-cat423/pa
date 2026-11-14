import fs from 'node:fs';

// Keep the frozen patch untouched; only retry an EOL-normalized copy after a strict check fails.
export function applyReleasePatch(git, patchPath, env) {
  let checkedPatch = patchPath;
  try {
    git(['apply', '--check', '--cached', '--whitespace=nowarn', patchPath], env);
  } catch (error) {
    const bytes = fs.readFileSync(patchPath);
    if (!bytes.includes(Buffer.from('\r\n'))) throw error;
    checkedPatch = patchPath + '.lf';
    const normalized = Buffer.from(bytes.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
    fs.writeFileSync(checkedPatch, normalized, { mode: 0o600, flush: true });
    git(['apply', '--check', '--cached', '--whitespace=nowarn', checkedPatch], env);
  }
  git(['apply', '--cached', '--whitespace=nowarn', checkedPatch], env);
}
