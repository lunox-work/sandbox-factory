// Read compiler settings and import syntax. Never load repository JavaScript.
import ts from "typescript-compiler";
import { readFileSync, existsSync } from "node:fs";
import { relative, resolve, dirname, isAbsolute } from "node:path";

const root = resolve(process.argv[2]);
const files = JSON.parse(readFileSync(process.argv[3], "utf8"));
const inside = (path) => {
  const rel = relative(root, resolve(path));
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith("../");
};
const read = (path) =>
  inside(path) && existsSync(path) ? readFileSync(path, "utf8") : undefined;
const host = {
  fileExists: (path) => inside(path) && ts.sys.fileExists(path),
  readFile: read,
  directoryExists: (path) => inside(path) && ts.sys.directoryExists(path),
  getCurrentDirectory: () => root,
  getDirectories: (path) => (inside(path) ? ts.sys.getDirectories(path) : []),
  realpath: ts.sys.realpath,
};
const configs = new Map();
const output = [];
for (const file of files) {
  if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
  const absolute = resolve(root, file);
  let config;
  for (let dir = dirname(absolute); inside(dir); dir = dirname(dir)) {
    const candidate = resolve(dir, "tsconfig.json");
    if (existsSync(candidate)) {
      config = candidate;
      break;
    }
    if (dir === root) break;
  }
  let options = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    allowJs: true,
    resolveJsonModule: true,
  };
  if (config) {
    if (!configs.has(config)) {
      const loaded = ts.readConfigFile(config, read);
      const parsed = ts.parseJsonConfigFileContent(
        loaded.config ?? {},
        { ...host, useCaseSensitiveFileNames: true, readDirectory: () => [] },
        dirname(config),
        undefined,
        config,
      );
      configs.set(config, {
        options: parsed.options,
        invalid:
          Boolean(loaded.error) ||
          parsed.errors.some((error) => error.code !== 18003),
      });
    }
    options = { ...options, ...configs.get(config).options };
  }
  const text = read(absolute) ?? "";
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const dependencies = ts
    .preProcessFile(text, true, true)
    .importedFiles.map((imported) => {
      const result = ts.resolveModuleName(
        imported.fileName,
        absolute,
        options,
        host,
      ).resolvedModule;
      return {
        specifier: imported.fileName,
        line: source.getLineAndCharacterOfPosition(imported.pos).line + 1,
        resolved:
          result && inside(result.resolvedFileName)
            ? relative(root, result.resolvedFileName).replaceAll("\\", "/")
            : null,
        external:
          Boolean(result?.isExternalLibraryImport) ||
          imported.fileName.startsWith("node:"),
        reason: result ? null : "unresolved",
      };
    });
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    ) {
      const argument = node.arguments[0];
      if (!argument || !ts.isStringLiteralLike(argument))
        dependencies.push({
          specifier: null,
          line: source.getLineAndCharacterOfPosition(node.pos).line + 1,
          resolved: null,
          external: false,
          reason: "dynamic",
        });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  output.push({
    file,
    dependencies,
    invalidConfig: config ? configs.get(config).invalid : false,
  });
}
process.stdout.write(JSON.stringify(output));
