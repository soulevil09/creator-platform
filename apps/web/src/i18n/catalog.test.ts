// @vitest-environment node
// =============================================================================
// Catalog hygiene (Session 10, D1 acceptance).
//
//   * `en` and `pt-BR` have full key parity — no key present in one and
//     missing in the other, no empty value, no nested-shape drift
//   * every ICU placeholder used in one language is used in the other
//   * no literal user-facing copy remains in the in-scope source files: no
//     JSX text node longer than 3 words, no long `aria-label` / `alt` /
//     `title` / `placeholder` string attribute
// =============================================================================
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import en from '../../messages/en.json';
import ptBR from '../../messages/pt-BR.json';

type Tree = { [key: string]: string | Tree };

function leaves(tree: Tree, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out.set(path, value);
    else for (const [k, v] of leaves(value, path)) out.set(k, v);
  }
  return out;
}

const placeholders = (message: string) =>
  [...message.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('message catalogs', () => {
  const enLeaves = leaves(en as Tree);
  const ptLeaves = leaves(ptBR as Tree);

  it('have full key parity', () => {
    expect([...ptLeaves.keys()].sort()).toEqual([...enLeaves.keys()].sort());
  });

  it('have no empty strings', () => {
    for (const [key, value] of [...enLeaves, ...ptLeaves]) {
      expect(value.trim(), key).not.toBe('');
    }
  });

  it('use the same ICU placeholders in both languages', () => {
    for (const [key, value] of enLeaves) {
      expect(placeholders(ptLeaves.get(key)!), key).toEqual(placeholders(value));
    }
  });
});

// ── No literal copy left in the in-scope files ───────────────────────────────
const WEB_ROOT = resolve(__dirname, '../..');
const IN_SCOPE = [
  'src/app/layout.tsx',
  'src/app/page.tsx',
  'src/app/wallet/page.tsx',
  'src/components/ProtectedMedia.tsx',
  // Not in the spec's list of four, but externalised "for consistency".
  'src/app/dev/protected-media/page.tsx',
  'src/components/LocaleSwitcher.tsx',
];
const MAX_WORDS = 3;

const words = (text: string) => text.match(/\p{L}[\p{L}\p{M}'’-]*/gu) ?? [];

/** Strip block, line and JSX comments so commentary is never counted as copy. */
function stripComments(source: string): string {
  return source
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/**
 * JSX text nodes: text between a `>` and a `<` with no expression braces.
 * `>` also closes TypeScript generics (`useState<T>(null)`), so a candidate
 * containing statement punctuation (`;`, `=`, a backtick) is code, not copy.
 */
function longJsxTextNodes(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/>([^<>{}]+)</g)) {
    const text = match[1].trim();
    if (/[;=`]/.test(text)) continue;
    if (words(text).length > MAX_WORDS) found.push(text);
  }
  return found;
}

/** Human-facing string attributes written as literals. */
function longLiteralAttributes(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(
    /\b(aria-label|alt|title|placeholder|legend)=["']([^"']+)["']/g,
  )) {
    if (words(match[2]).length > MAX_WORDS) found.push(match[0]);
  }
  return found;
}

describe('no literal user-facing copy in the in-scope web files', () => {
  it.each(IN_SCOPE)('%s', (file) => {
    const source = stripComments(readFileSync(resolve(WEB_ROOT, file), 'utf8'));
    expect(longJsxTextNodes(source)).toEqual([]);
    expect(longLiteralAttributes(source)).toEqual([]);
  });

  it('the check itself catches what it is meant to catch', () => {
    const offending = `<p>Plataforma de monetização para criadores</p>
<button aria-label="Comprar pacote inicial com cem créditos">x</button>`;
    expect(longJsxTextNodes(offending)).toHaveLength(1);
    expect(longLiteralAttributes(offending)).toHaveLength(1);
    // Short brand names and expressions are fine.
    expect(longJsxTextNodes('<h1>VisorFans</h1><p>{t("x")}</p>')).toEqual([]);
  });
});
