import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHANGELOG } from '../src/ui/changelogEntries';
import { GROUPS, PARAMS } from '../src/core/params';
import { ALL_TABS } from '../src/state/workspaces';

// every .tsx under src/ui, read once: "Show me" names must exist as a data-hl or data-testid
const uiDir = join(__dirname, '../src/ui');
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? files(join(dir, d.name)) : d.name.endsWith('.tsx') ? [join(dir, d.name)] : []));
const source = files(uiDir)
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n');
const literal = new Set([...source.matchAll(/(?:data-hl|data-testid|\bhl)=["{]?["'`]?([a-z0-9-]+)["'`]/g)].map((m) => m[1]));
// names built from a template, e.g. data-testid={`viewport-layer-${id}`}
const templated = [...source.matchAll(/(?:data-hl|data-testid)=\{`([a-z0-9-]+)\$\{/g)].map((m) => m[1]);
const known = (name: string) => literal.has(name) || templated.some((p) => name.startsWith(p));

describe('changelog', () => {
  it('lists the newest first with real dates', () => {
    for (const e of CHANGELOG) expect(e.date, e.title).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const dates = CHANGELOG.map((e) => e.date);
    expect(dates).toEqual([...dates].sort().reverse());
  });

  it('has one entry per change', () => {
    const keys = CHANGELOG.map((e) => `${e.date}|${e.title}`);
    expect(new Set(keys).size).toBe(keys.length);
    const prs = CHANGELOG.flatMap((e) => (e.pr ? [e.pr] : []));
    expect(new Set(prs).size).toBe(prs.length);
  });

  it('says what and where in words', () => {
    for (const e of CHANGELOG) {
      expect(e.title.trim(), JSON.stringify(e)).not.toBe('');
      expect(e.body.trim(), e.title).not.toBe('');
      expect(e.where.trim(), e.title).not.toBe('');
    }
  });

  it('points "Show me" at controls, params, groups and tabs that exist', () => {
    const ids = new Set(PARAMS.map((p) => p.id));
    for (const e of CHANGELOG) {
      const t = e.target;
      if (!t) continue;
      if (t.tab) expect(ALL_TABS, e.title).toContain(t.tab);
      if (t.param) expect(ids.has(t.param), `${e.title}: param ${t.param}`).toBe(true);
      if (t.group) expect(GROUPS as readonly string[], e.title).toContain(t.group);
      for (const name of t.path ?? []) expect(known(name), `${e.title}: no data-hl or data-testid "${name}" in src/ui`).toBe(true);
      expect(t.tab || t.param || t.group || t.path?.length, `${e.title}: empty target`).toBeTruthy();
    }
  });
});
