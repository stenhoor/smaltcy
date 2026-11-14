import { defineConfig } from 'vitepress'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { smaltLight, smaltDark } from './theme/shiki'
import { smaltworksMenu, smaltworksFooter } from './theme/smaltworks'
import { readFileSync } from 'node:fs'
import { playgroundPlugin } from './theme/playground'
import { railroadPlugin } from './theme/railroad'
import { agentDocs, packageVersion } from './theme/agents'

const here = path.dirname(fileURLToPath(import.meta.url))
const REPO = 'https://github.com/stenhoor/smaltcy'
// GitHub Pages serves the site under the repository's name.
const BASE = process.env.SMALTCY_BASE ?? '/smaltcy/'
// smaltcy's Cypher, written from the parser and tested against it (test/grammar.test.ts): the syntax diagrams and the
// agent guide read it.
const GRAMMAR = readFileSync(path.resolve(here, '../grammar.ebnf'), 'utf8')

// A function group in the sidebar: its page, then a page per function, in the order of the group page's list
// (`- [`name`](./page): summary`), so the sidebar and the group page cannot disagree. As smaltql's site does.
function functionGroup(text: string, group: string) {
  const md = readFileSync(path.resolve(here, `../reference/functions/${group}/index.md`), 'utf8')
  const items = [...md.matchAll(/^- \[`(.+?)`\]\(\.\/([\w-]+)\): /gm)].map(([, label, page]) => ({
    text: label,
    link: `/reference/functions/${group}/${page}`,
  }))
  return { text, link: `/reference/functions/${group}/`, collapsed: true, items }
}

export default defineConfig({
  title: 'smaltcy',
  description: 'A graph database for the browser that speaks Cypher, written in TypeScript.',
  base: BASE,
  cleanUrls: true,
  rewrites: { 'adr/README.md': 'adr/index.md' },
  lastUpdated: false,
  // Markdown for AI agents beside the pages: a twin of each page, /llms.txt and /agents.md (BRAND.md, Documentation).
  buildEnd: (config) => {
    agentDocs(config, {
      product: 'smaltcy',
      version: packageVersion(path.resolve(here, '../../package.json')),
      url: `https://stenhoor.github.io${BASE}`,
      intro: 'guide/agents.md',
      grammar: GRAMMAR,
      guide: ['reference/cypher/', 'reference/functions/', 'reference/divergences', 'reference/api'],
    })
  },
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: `${BASE}favicon-32.svg` }],
    ['link', { rel: 'preconnect', href: 'https://fonts.googleapis.com' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' }],
    ['link', { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=Geist:wght@400;500;700&family=Geist+Mono:wght@400;500&family=Martian+Mono:wght@400;600&display=swap' }],
  ],
  vite: {
    resolve: {
      alias: [
        { find: /^@smaltworks\/smaltcy$/, replacement: path.resolve(here, '../../src/index.ts') },
        { find: /^@smaltworks\/smaltcy\/(.*)$/, replacement: path.resolve(here, '../../src/$1/index.ts') },
      ],
    },
    worker: { format: 'es' },
  },
  markdown: {
    theme: { light: smaltLight, dark: smaltDark },
    languageAlias: { cypher: 'sql' },
    config(md) {
      // Every cypher example runs where it stands, on its sample dataset (BRAND.md, Documentation, rule 7; theme/cypher.ts).
      md.use(playgroundPlugin, { languages: ['cypher'] })
      // ```railroad fences draw rules of the grammar as syntax diagrams (rule 4).
      md.use(railroadPlugin, { grammar: GRAMMAR })
      // Links that leave docs/ point at the file on GitHub.
      const fallback = md.renderer.rules.link_open ?? ((t, i, o, _e, s) => s.renderToken(t, i, o))
      md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
        const href = tokens[idx].attrGet('href')
        if (href && !/^[a-z]+:|^#|^\//i.test(href) && env?.relativePath) {
          const target = path.posix.normalize(path.posix.join(path.posix.dirname(env.relativePath), href))
          if (target.startsWith('../')) {
            tokens[idx].attrSet('href', `${REPO}/blob/HEAD/${target.slice(3)}`)
            tokens[idx].attrSet('target', '_blank')
            tokens[idx].attrSet('rel', 'noreferrer')
          }
        }
        return fallback(tokens, idx, options, env, self)
      }
    },
  },
  themeConfig: {
    logo: { light: '/lockup.svg', dark: '/lockup-on-dark.svg', alt: 'smaltcy' },
    siteTitle: false,
    // The four sections of every smalt site (BRAND.md, Documentation, rule 1).
    nav: [
      { text: 'Quick start', link: '/guide/quick-start' },
      { text: 'Guide', link: '/guide/getting-started' },
      {
        text: 'Reference',
        items: [
          {
            text: 'Language',
            items: [
              { text: 'Cypher', link: '/reference/cypher/' },
              { text: 'Functions', link: '/reference/functions/' },
              { text: 'Where it differs', link: '/reference/divergences' },
            ],
          },
          {
            text: 'API and engine',
            items: [
              { text: 'API', link: '/reference/api' },
              { text: 'Plans', link: '/reference/plans' },
              { text: 'Stores', link: '/reference/stores' },
            ],
          },
          {
            text: 'Internals',
            items: [
              { text: 'Architecture', link: '/architecture' },
              { text: 'Decisions', link: '/adr/' },
              { text: 'Benchmarks', link: '/research/benchmarks' },
            ],
          },
        ],
      },
      { text: 'Playground', link: '/playground' },
      smaltworksMenu(),
    ],
    sidebar: [
      {
        text: 'Quick start',
        items: [{ text: 'Quick start', link: '/guide/quick-start' }],
      },
      {
        text: 'Getting started',
        items: [
          { text: 'Installation', link: '/guide/getting-started' },
          { text: 'Examples', link: '/guide/examples' },
          { text: 'Sample data', link: '/guide/sample-data' },
          { text: 'For AI agents', link: '/guide/agents' },
        ],
      },
      {
        text: 'User guide',
        items: [
          { text: 'Using the pieces', link: '/guide/modules' },
          { text: 'Time travel', link: '/guide/time-travel' },
          { text: 'Drawing graphs', link: '/guide/rendering' },
          { text: 'Big graphs: the tech demo', link: '/demo' },
          { text: 'In a Web Worker', link: '/guide/worker' },
          { text: 'Saving and loading', link: '/guide/persistence' },
        ],
      },
      {
        text: 'Reference',
        items: [
          {
            text: 'Cypher',
            collapsed: false,
            items: [
              { text: 'Overview', link: '/reference/cypher/' },
              { text: 'MATCH', link: '/reference/cypher/match' },
              { text: 'RETURN', link: '/reference/cypher/return' },
              { text: 'WITH', link: '/reference/cypher/with' },
              { text: 'UNWIND', link: '/reference/cypher/unwind' },
              { text: 'CREATE', link: '/reference/cypher/create' },
              { text: 'MERGE', link: '/reference/cypher/merge' },
              { text: 'SET', link: '/reference/cypher/set' },
              { text: 'REMOVE', link: '/reference/cypher/remove' },
              { text: 'DELETE', link: '/reference/cypher/delete' },
              { text: 'UNION', link: '/reference/cypher/union' },
              { text: 'CREATE INDEX', link: '/reference/cypher/indexes' },
              { text: 'EXPLAIN', link: '/reference/cypher/explain' },
              { text: 'AT VERSION and AT TIME', link: '/reference/cypher/at' },
              { text: 'Patterns', link: '/reference/cypher/patterns' },
              { text: 'Expressions', link: '/reference/cypher/expressions' },
            ],
          },
          {
            text: 'Functions',
            collapsed: true,
            items: [
              { text: 'All functions', link: '/reference/functions/' },
              functionGroup('Graph', 'graph'),
              functionGroup('Lists', 'lists'),
              functionGroup('Strings', 'strings'),
              functionGroup('Conversion', 'conversion'),
              functionGroup('Math', 'math'),
              functionGroup('Aggregate', 'aggregate'),
              functionGroup('History', 'history'),
              functionGroup('Other', 'other'),
            ],
          },
          { text: 'Where it differs', link: '/reference/divergences' },
          { text: 'API', link: '/reference/api' },
          { text: 'Plans', link: '/reference/plans' },
          { text: 'Stores', link: '/reference/stores' },
          {
            text: 'Internals',
            collapsed: true,
            items: [
              { text: 'Architecture', link: '/architecture' },
              { text: 'Decisions', link: '/adr/' },
              { text: '0001 smaltcy', link: '/adr/0001-smaltcy' },
              { text: '0002 Graph history', link: '/adr/0002-graph-history' },
              { text: '0003 Drawing in smaltkit', link: '/adr/0003-drawing-in-smaltkit' },
              { text: 'Benchmarks', link: '/research/benchmarks' },
            ],
          },
        ],
      },
    ],
    socialLinks: [{ icon: 'github', link: REPO }],
    search: { provider: 'local' },
    outline: { level: [2, 3] },
    footer: smaltworksFooter(BASE),
  },
})
