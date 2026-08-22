const fs = require("fs");
const path = require("path");
const { Parser, Language, Query } = require("@vscode/tree-sitter-wasm");

const WASM_DIR = path.join(
  path.dirname(require.resolve("@vscode/tree-sitter-wasm/package.json")),
  "wasm"
);

const EXT_LANG = {
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".ts": "typescript",
  ".tsx": "tsx",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".cs": "c-sharp",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hh": "cpp",
  ".h": "cpp",
  ".php": "php",
  ".rb": "ruby",
};

const QUERIES = {
  javascript: `
    (import_statement source: (string) @path)
    (export_statement source: (string) @path)
    (call_expression
      function: (identifier) @fn
      arguments: (arguments . (string) @path)
      (#eq? @fn "require"))
    (call_expression
      function: (import)
      arguments: (arguments . (string) @path))
    (call_expression
      function: (import)
      arguments: (arguments . (_) @dynamic))
  `,
  typescript: `
    (import_statement source: (string) @path)
    (export_statement source: (string) @path)
    (call_expression
      function: (identifier) @fn
      arguments: (arguments . (string) @path)
      (#eq? @fn "require"))
    (call_expression
      function: (import)
      arguments: (arguments . (string) @path))
    (call_expression
      function: (import)
      arguments: (arguments . (_) @dynamic))
  `,
  tsx: `
    (import_statement source: (string) @path)
    (export_statement source: (string) @path)
    (call_expression
      function: (identifier) @fn
      arguments: (arguments . (string) @path)
      (#eq? @fn "require"))
    (call_expression
      function: (import)
      arguments: (arguments . (string) @path))
    (call_expression
      function: (import)
      arguments: (arguments . (_) @dynamic))
  `,
  python: `
    (import_from_statement module_name: (dotted_name) @name)
    (import_from_statement module_name: (relative_import) @name)
    (import_statement name: (dotted_name) @name)
    (import_statement name: (aliased_import name: (dotted_name) @name))
    (call
      function: (attribute attribute: (identifier) @fn)
      (#match? @fn "^(import_module|__import__)$")
      arguments: (argument_list . (_) @dynamic))
  `,
  go: `
    (import_spec path: (interpreted_string_literal) @path)
    (import_spec path: (raw_string_literal) @path)
  `,
  rust: `
    (mod_item name: (identifier) @mod)
    (use_declaration argument: (scoped_identifier) @use)
    (use_declaration argument: (identifier) @use)
    (use_declaration argument: (use_wildcard (scoped_identifier) @use))
    (use_declaration argument: (use_as_clause path: (_) @use))
    (macro_invocation
      macro: (identifier) @macro
      (#eq? @macro "include")
      (token_tree (string_literal) @path))
  `,
  java: `
    (import_declaration (scoped_identifier) @name)
    (import_declaration (identifier) @name)
  `,
  "c-sharp": `
    (using_directive (qualified_name) @name)
    (using_directive (identifier) @name)
  `,
  cpp: `
    (preproc_include path: (string_literal) @path)
    (preproc_include path: (system_lib_string) @system)
  `,
  php: `
    (include_expression (string) @path)
    (require_expression (string) @path)
    (include_once_expression (string) @path)
    (require_once_expression (string) @path)
  `,
  ruby: `
    (call
      method: (identifier) @fn
      (#match? @fn "^(require|require_relative|load)$")
      arguments: (argument_list (string) @path))
  `,
};

let ready = null;
const languages = new Map();
const queries = new Map();

function wasmFile(lang) {
  return path.join(WASM_DIR, `tree-sitter-${lang}.wasm`);
}

async function initTreeSitter() {
  if (ready) return ready;
  ready = (async () => {
    await Parser.init({
      locateFile: (file) => path.join(WASM_DIR, path.basename(file)),
    });
    const langs = [...new Set(Object.values(EXT_LANG))];
    for (const lang of langs) {
      const file = wasmFile(lang);
      if (!fs.existsSync(file)) continue;
      try {
        const language = await Language.load(file);
        languages.set(lang, language);
        const src = QUERIES[lang];
        if (src) {
          try {
            queries.set(lang, new Query(language, src));
          } catch (err) {
            console.warn(`[relay] tree-sitter query failed for ${lang}:`, err.message);
          }
        }
      } catch (err) {
        console.warn(`[relay] tree-sitter language ${lang} failed:`, err.message);
      }
    }
    return true;
  })();
  return ready;
}

function unquote(text) {
  const t = String(text || "").trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")) || (t.startsWith("`") && t.endsWith("`"))) {
    return t.slice(1, -1);
  }
  if (t.startsWith("<") && t.endsWith(">")) return t.slice(1, -1);
  return t;
}

function extractWithQuery(lang, source) {
  const language = languages.get(lang);
  const query = queries.get(lang);
  if (!language) return { staticSpecs: [], dynamic: [], engine: "none" };
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(source);
  if (!tree) return { staticSpecs: [], dynamic: [], engine: "tree-sitter" };
  const staticSpecs = [];
  const dynamic = [];
  if (query) {
    for (const cap of query.captures(tree.rootNode)) {
      const name = cap.name;
      const text = unquote(cap.node.text);
      if (!text) continue;
    if (name === "dynamic") {
      if (/^['"]/.test(cap.node.text) || text.startsWith(".")) staticSpecs.push(text);
      else dynamic.push(text);
    } else if (name === "system") dynamic.push(text);
      else if (name === "fn" || name === "macro") continue;
      else staticSpecs.push(text);
    }
  }
  tree.delete();
  parser.delete();
  return {
    staticSpecs: [...new Set(staticSpecs)],
    dynamic: [...new Set(dynamic)],
    engine: "tree-sitter",
  };
}

function languageForExt(ext) {
  return EXT_LANG[ext] || null;
}

function supportedLanguages() {
  return [...languages.keys()];
}

module.exports = {
  initTreeSitter,
  extractWithQuery,
  languageForExt,
  supportedLanguages,
  EXT_LANG,
};
