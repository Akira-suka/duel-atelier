import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const banned = files.filter(file => (/^(?:src\/theme\/local\/|public\/art\/eva\/|node_modules\/|dist\/|data\/|tools\/|\.env(?:\.|$))/.test(file) || /\.sqlite(?:-wal|-shm)?$/.test(file)) && file !== '.env.example');
if (banned.length) throw new Error('Private/generated files tracked: ' + banned.join(', '));
for (const file of files) {
  if (statSync(file).size > 10_000_000) throw new Error('Unexpected large source file: ' + file);
  if (/\.(?:tsx?|mjs|json|md|ya?ml)$/.test(file)) {
    const content = readFileSync(file, 'utf8');
    if (/(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,}|-----BEGIN (?:RSA |OPENSSH )?PRIVATE KEY-----)/.test(content)) throw new Error('Possible credential in: ' + file);
  }
}
console.log('Release boundary audit passed for ' + files.length + ' tracked files.');
