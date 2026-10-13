import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const catalogs = import.meta.glob<{ en: Record<string, string> }>('../shared/locales/*.ts', { eager: true });
const root = resolve(import.meta.dirname, '..');

/** Dynamic keys are reviewed individually; adding a new call requires reviewing its data source. */
const reviewedDynamicKeys: Record<string, string> = {
  "src/App.tsx:NAV.find((item) => item.id === page)?.label || '设置'": 'App-owned NAV labels and the Settings fallback; translate when rendering to respond to locale changes.',
  'src/App.tsx:label': 'The label destructured from the fixed NAV array.',
  'src/components/BatchComposer.tsx:forkError': 'App errors retain source keys in state; already-localized or unmatched remote errors pass through unchanged.',
  'src/components/BatchComposer.tsx:targetsError': 'App errors retain source keys in state; already-localized or unmatched remote errors pass through unchanged.',
  'src/components/BatchComposer.tsx:filename.extensionError': 'An extension validation error, already localized by the shared filename helper.',
  'src/components/BatchComposer.tsx:filename.authorError || filename.error': 'An author or complete filename validation error, already localized by the shared filename helper.',
  'src/components/BatchComposer.tsx:dayError': 'App errors retain source keys in state; already-localized or unmatched remote errors pass through unchanged.',
  'src/components/BatchComposer.tsx:error': 'App errors retain source keys in state; already-localized or unmatched remote errors pass through unchanged.',
  'src/components/BatchComposer.tsx:file.problem.sourceWarning': 'A warning produced by the application problem parser, not repository text.',
  'src/components/BatchComposer.tsx:progress.message': 'App-owned submission progress, including an initial source key stored in component state.',
  'src/components/QueuePreview.tsx:file.problem.sourceWarning': 'A warning produced by the application problem parser, not repository text.',
  'src/components/ContributionList.tsx:FILE_STATUS_LABELS[file.status]': 'A closed map of GitHub file-status labels.',
  'src/components/ForkSettings.tsx:message': 'One of the two fixed success messages stored as source keys in component state.',
  'src/components/ProblemContributionStatus.tsx:STATE_LABELS[record.state]': 'A closed map of open, merged, and closed PR labels.',
  'src/components/ProblemContributionStatus.tsx:STATE_LABELS[state]': 'A closed map of open, merged, and closed PR labels.',
  'src/components/TemplateSettings.tsx:variable.label': 'Application-owned TEMPLATE_VARIABLES descriptions; custom user template content is not translated.',
  'src/components/TemplateSettings.tsx:variable.example': 'Application-owned TEMPLATE_VARIABLES examples; custom user template content is not translated.',
  'electron/guards.ts:name': 'Application-supplied validation field labels; all Chinese call-site values are checked below.',
  'electron/storage.ts:key': 'Application-owned warning keys translated by a getter after system locale initialization and subsequent switches.',
};

const nonMessageChinese = new Set([
  'src/components/AppearanceSettings.tsx:简体中文', // A language selector displays each language in its own language.
  'src/components/CodeHighlight.tsx:文本', // A recognized input alias, not UI text.
]);

interface Finding { file: string; line: number; text: string; reason?: string }

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'locales' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [path] : [];
  });
}

function audit() {
  const files = ['src', 'electron', 'shared'].flatMap(directory => sourceFiles(join(root, directory)));
  const program = ts.createProgram(files, { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, noResolve: true });
  const checker = program.getTypeChecker();
  const keys = new Set(Object.values(catalogs).flatMap(catalog => Object.keys(catalog.en)));
  const dynamicCalls: Finding[] = [];
  const missingKeys: Finding[] = [];
  const untranslatedCandidates: Finding[] = [];
  const usedKeys = new Set<string>();
  let messageCalls = 0;

  function literalKeys(node: ts.Expression, seen = new Set<ts.Node>()): string[] | undefined {
    if (seen.has(node)) return undefined;
    seen.add(node);
    if (ts.isStringLiteralLike(node)) return [node.text];
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) return literalKeys(node.expression, seen);
    if (ts.isConditionalExpression(node)) {
      const yes = literalKeys(node.whenTrue, new Set(seen));
      const no = literalKeys(node.whenFalse, new Set(seen));
      return yes && no ? [...yes, ...no] : undefined;
    }
    if (ts.isIdentifier(node)) {
      const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration;
      if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) return literalKeys(declaration.initializer, seen);
    }
    return undefined;
  }

  for (const file of files) {
    const source = program.getSourceFile(file) ?? ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
    const filename = relative(root, file).replaceAll('\\', '/');
    const isTranslation = (node: ts.Node): node is ts.CallExpression => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 't';
    const finding = (node: ts.Node, text: string): Finding => ({ file: filename, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, text });
    function translatedAncestor(node: ts.Node): boolean {
      for (let parent = node.parent; parent; parent = parent.parent) {
        if (isTranslation(parent) && parent.arguments[0] && node.pos >= parent.arguments[0].pos && node.end <= parent.arguments[0].end) return true;
      }
      return false;
    }
    function visit(node: ts.Node) {
      if (isTranslation(node) && node.arguments[0]) {
        messageCalls++;
        const values = literalKeys(node.arguments[0]);
        if (values) {
          for (const key of values) {
            usedKeys.add(key);
            if (!keys.has(key)) missingKeys.push(finding(node, key));
          }
        } else {
          const expression = node.arguments[0].getText(source).replace(/\s+/g, ' ');
          dynamicCalls.push({ ...finding(node, expression), reason: reviewedDynamicKeys[`${filename}:${expression}`] });
        }
      }
      if ((ts.isStringLiteralLike(node) || ts.isJsxText(node) || ts.isTemplateExpression(node)) && !translatedAncestor(node)) {
        const text = ts.isStringLiteralLike(node) || ts.isJsxText(node) ? node.text : node.getText(source);
        if (/[\p{Script=Han}]/u.test(text)) untranslatedCandidates.push(finding(node, text.trim()));
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }

  const conflicts: { key: string; first: { file: string; value: string }; other: { file: string; value: string } }[] = [];
  const definitions = new Map<string, { file: string; value: string }>();
  for (const [file, catalog] of Object.entries(catalogs)) {
    for (const [key, value] of Object.entries(catalog.en)) {
      const first = definitions.get(key);
      if (first && first.value !== value) conflicts.push({ key, first, other: { file, value } });
      else if (!first) definitions.set(key, { file, value });
    }
  }
  return {
    generatedAt: new Date().toISOString(), fileCount: files.length, messageCalls, staticKeyCount: usedKeys.size,
    catalogKeyCount: keys.size, missingKeys, dynamicCalls,
    unreviewedDynamicCalls: dynamicCalls.filter(finding => !finding.reason),
    catalogConflicts: conflicts,
    untranslatedCandidates: untranslatedCandidates.map(finding => ({ ...finding,
      inCatalog: keys.has(finding.text), nonMessage: nonMessageChinese.has(`${finding.file}:${finding.text}`),
    })),
  };
}

describe('application translation coverage', () => {
  it('covers literal messages and documents every dynamic translation source', () => {
    const result = audit();
    const report = join(root, 'test-results', 'i18n-audit.json');
    mkdirSync(dirname(report), { recursive: true });
    writeFileSync(report, JSON.stringify(result, null, 2));
    expect(result.missingKeys, 'Missing translations; see test-results/i18n-audit.json').toEqual([]);
    expect(result.unreviewedDynamicCalls, 'Unreviewed dynamic translations; see test-results/i18n-audit.json').toEqual([]);
    expect(result.untranslatedCandidates.filter(finding => !finding.inCatalog && !finding.nonMessage),
      'Uncatalogued Chinese literal candidates; review test-results/i18n-audit.json').toEqual([]);
    expect(result.catalogConflicts, 'Conflicting translations; see test-results/i18n-audit.json').toEqual([]);
  });
});
