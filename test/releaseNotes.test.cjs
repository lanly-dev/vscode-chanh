const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

// Exercise the pure release-notes helpers without a VS Code host. The
// helpers live in src/releaseNotesCore.ts (vscode-free by design); this test
// transpiles that one file with the project's own TypeScript compiler and
// loads it in a vm context, the same source-loading trick demo.test.cjs
// uses for demo.js. Requires devDependencies to be installed (typescript).
function loadCore() {
  const ts = require('typescript');
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'releaseNotesCore.ts'), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const m = { exports: {} };
  vm.runInNewContext(outputText, { module: m, exports: m.exports, require, console });
  return m.exports;
}
const core = loadCore();

// Arrays built inside the vm realm fail deepStrictEqual's prototype check
// against local arrays, so bullet lists are compared as joined text.
const asText = (bullets) => bullets.join('\n');

const CHANGELOG = [
  '# Change Log',
  'All notable changes to the "Chanh" extension will be documented in this file.\\',
  '',
  '## [TODO]',
  '- Token stats logs',
  '- Ghost inline',
  '',
  '## [0.1.4] - 2026-10-28',
  '- Add Copy ID context menu options',
  '- Add custom model group',
  '',
  '## [0.1.3] - 2026-10-18',
  '- Add system utilization treeview display',
  '',
].join('\n');

const README = [
  '# Chanh',
  '',
  '## Release Notes',
  '',
  '### 0.1.4',
  '- Add Copy ID context menu options',
  '',
  '### 0.1.3',
  '- Add token count footer option',
  '',
  '**Enjoy!**',
  '',
].join('\n');

test('findVersionBump returns the newest commit that changed the version', () => {
  const commits = [
    { hash: 'h3', version: '0.1.5' },
    { hash: 'h2', version: '0.1.5' },
    { hash: 'h1', version: '0.1.4' },
  ];
  assert.equal(core.findVersionBump(commits), 'h2');
  assert.equal(
    core.findVersionBump([
      { hash: 'h2', version: '0.1.5' },
      { hash: 'h1', version: '0.1.4' },
    ]),
    'h2'
  );
});

test('findVersionBump returns undefined when the version never changed', () => {
  assert.equal(
    core.findVersionBump([
      { hash: 'h2', version: '0.1.4' },
      { hash: 'h1', version: '0.1.4' },
    ]),
    undefined
  );
  assert.equal(core.findVersionBump([{ hash: 'h1', version: '0.1.4' }]), undefined);
  assert.equal(core.findVersionBump([]), undefined);
});

test('extractBullets normalizes markers, drops fences/headings/prose, dedupes', () => {
  const raw = [
    'Here are the release notes:',
    '## [0.1.5]',
    '```markdown',
    '- Add thing',
    '* Improve other',
    '1. Fix third',
    '```',
    '- Add thing',
    'A prose line that is not a bullet.',
  ].join('\n');
  assert.equal(asText(core.extractBullets(raw)), '- Add thing\n- Improve other\n- Fix third');
  assert.equal(core.extractBullets('no bullets here').length, 0);
});

test('changelog: a new version section lands below TODO, above the previous version', () => {
  const { content, outcome } = core.insertChangelogSection(
    CHANGELOG, '0.1.5', '2026-10-29', ['- Add token stats logs']
  );
  assert.equal(outcome, 'inserted');
  const todoAt = content.indexOf('## [TODO]');
  const newAt = content.indexOf('## [0.1.5] - 2026-10-29');
  const prevAt = content.indexOf('## [0.1.4]');
  assert.ok(todoAt >= 0 && newAt > todoAt && prevAt > newAt);
  assert.ok(content.includes('## [0.1.5] - 2026-10-29\n- Add token stats logs'));
});

test('changelog: fallback note becomes an HTML comment above the new section', () => {
  const { content } = core.insertChangelogSection(
    CHANGELOG, '0.1.5', '2026-10-29', ['- Add thing'], 'Drafted from the last 50 commits.'
  );
  const noteAt = content.indexOf('<!-- Drafted from the last 50 commits. -->');
  assert.ok(noteAt >= 0 && noteAt < content.indexOf('## [0.1.5]'));
});

test('changelog: an existing section with content is never overwritten', () => {
  const { content, outcome } = core.insertChangelogSection(
    CHANGELOG, '0.1.4', '2026-10-29', ['- Replacement bullet']
  );
  assert.equal(outcome, 'exists');
  assert.equal(content, CHANGELOG);
});

test('changelog: an existing empty section is filled in place', () => {
  const withEmpty = CHANGELOG.replace(
    '## [0.1.4] - 2026-10-28',
    '## [0.1.5] -\n\n## [0.1.4] - 2026-10-28'
  );
  const { content, outcome } = core.insertChangelogSection(
    withEmpty, '0.1.5', '2026-10-29', ['- Add token stats logs']
  );
  assert.equal(outcome, 'filled');
  assert.ok(content.includes('## [0.1.5] -\n- Add token stats logs\n\n## [0.1.4]'));
});

test('readme: a new version heading is created newest-first under Release Notes', () => {
  const { content, outcome } = core.applyReadmeSection(README, '0.1.5', ['- Add token stats logs']);
  assert.equal(outcome, 'inserted');
  const relAt = content.indexOf('## Release Notes');
  const newAt = content.indexOf('### 0.1.5');
  const prevAt = content.indexOf('### 0.1.4');
  assert.ok(relAt >= 0 && newAt > relAt && prevAt > newAt);
  assert.ok(content.includes('### 0.1.5\n- Add token stats logs'));
});

test('readme: an existing section with content is never overwritten', () => {
  const { content, outcome } = core.applyReadmeSection(README, '0.1.4', ['- Replacement bullet']);
  assert.equal(outcome, 'exists');
  assert.equal(content, README);
});

test('readme: an existing empty heading is filled in place', () => {
  const withEmpty = README.replace('### 0.1.4', '### 0.1.5\n\n### 0.1.4');
  const { content, outcome } = core.applyReadmeSection(withEmpty, '0.1.5', ['- Add token stats logs']);
  assert.equal(outcome, 'filled');
  assert.ok(content.includes('### 0.1.5\n- Add token stats logs\n\n### 0.1.4'));
});

test('buildDraftMessages carries the version, subjects, and style rules', () => {
  const { system, user } = core.buildDraftMessages('0.1.5', ['feat: add thing'], ['- src/a.ts (2 commits)']);
  assert.ok(system.includes('ONLY a bullet list'));
  assert.ok(user.includes('version 0.1.5'));
  assert.ok(user.includes('- feat: add thing'));
  assert.ok(user.includes('src/a.ts'));
});
