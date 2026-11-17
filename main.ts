// Build the submission bundle: game files, screenshots, and the dossier.
// Written fresh for the CHAINFIRE 3D rebuild (same kit contract as the
// starter: copy game/ + screenshots/ to /output, write dossier.json with
// buildDossier from vendor/makefun-game.ts).
import { existsSync, mkdirSync, readdirSync, readFileSync, lstatSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-game.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here);
const outputDir = resolve(process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

function isPlainFile(path) {
  try {
    return lstatSync(path).isFile();
  } catch (err) {
    return false;
  }
}

function copyTree(sourceDir, targetDir) {
  if (!existsSync(sourceDir)) return 0;
  const stack = [{ source: sourceDir, target: targetDir }];
  let copied = 0;
  while (stack.length > 0) {
    const { source, target } = stack.pop();
    mkdirSync(target, { recursive: true });
    let entries;
    try {
      entries = readdirSync(source, { withFileTypes: true });
    } catch (err) {
      continue;
    }
    for (const entry of entries) {
      const from = join(source, entry.name);
      const to = join(target, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push({ source: from, target: to });
        continue;
      }
      if (!entry.isFile() || !isPlainFile(from)) continue;
      copyFileSync(from, to);
      copied += 1;
    }
  }
  return copied;
}

function copyLooseFiles(sourceDir, targetDir) {
  if (!existsSync(sourceDir)) return 0;
  mkdirSync(targetDir, { recursive: true });
  let copied = 0;
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const from = join(sourceDir, entry.name);
    if (!isPlainFile(from)) continue;
    copyFileSync(from, join(targetDir, entry.name));
    copied += 1;
  }
  return copied;
}

mkdirSync(outputDir, { recursive: true });

const gameCount = copyTree(join(repoRoot, 'game'), join(outputDir, 'game'));
const shotCount = copyLooseFiles(join(repoRoot, 'screenshots'), join(outputDir, 'screenshots'));

const dossier = buildDossier(outputDir, {
  text_max_bytes: 163840,
  screenshots: { max: 4, max_bytes: 262144 },
  game_max_files: 993,
  game_max_bytes: 50331648,
  game_path_max_bytes: 1000
});

const dossierBytes = dossier instanceof Uint8Array ? dossier : new Uint8Array(dossier);
const dossierPath = join(outputDir, 'dossier.json');
writeFileSync(dossierPath, dossierBytes);
if (!existsSync(dossierPath)) {
  throw new Error('dossier write failed');
}
const verified = readFileSync(dossierPath);

console.log(
  `CHAINFIRE 3D bundle: ${gameCount} game files, ${shotCount} screenshots, dossier ${verified.byteLength} bytes -> ${dossierPath}`
);
