const fs = require("fs");
const path = require("path");

const IMPORT_RE =
  /(?:import\s+(?:[\s\S]*?)\s+from\s+|require\s*\(|from\s+)['"]([^'"]+)['"]/g;

function normalizeRel(fromFile, spec) {
  if (!spec.startsWith(".")) return null;
  const dir = path.posix.dirname(fromFile.replace(/\\/g, "/"));
  let resolved = path.posix.normalize(path.posix.join(dir, spec)).replace(/^\.\//, "");
  return resolved.replace(/\\/g, "/");
}

function parseImports(source, fromFile) {
  const out = [];
  let m;
  const re = new RegExp(IMPORT_RE);
  while ((m = re.exec(source))) {
    const rel = normalizeRel(fromFile, m[1]);
    if (rel) out.push(rel);
  }
  return out;
}

function resolveExisting(workspacePath, rel) {
  const bases = [rel, `${rel}.ts`, `${rel}.tsx`, `${rel}.js`, `${rel}.jsx`, path.posix.join(rel, "index.ts")];
  for (const b of bases) {
    const abs = path.join(workspacePath, b);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return b.replace(/\\/g, "/");
  }
  return rel;
}

function dependsOn(workspacePath, filePath) {
  try {
    const rel = filePath.replace(/\\/g, "/").replace(/^\.?\//, "");
    const abs = path.join(workspacePath, rel);
    if (!fs.existsSync(abs)) return [];
    const src = fs.readFileSync(abs, "utf8");
    return parseImports(src, rel).map((d) => resolveExisting(workspacePath, d));
  } catch {
    return [];
  }
}

module.exports = { dependsOn, parseImports };
