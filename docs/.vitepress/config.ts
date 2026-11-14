import { defineConfig } from 'vitepress'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { smaltLight, smaltDark } from './theme/shiki'
import { smaltworksMenu, smaltworksFooter } from './theme/smaltworks'
import { playgroundPlugin } from './theme/playground'
import { agentDocs, packageVersion } from './theme/agents'

const here = path.dirname(fileURLToPath(import.meta.url))
const REPO = 'https://github.com/stenhoor/smaltcy'
// GitHub Pages serves the site under the repository's name.
const BASE = process.env.SMALTCY_BASE ?? '/smaltcy/'

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
      guide: ['reference/cypher', 'reference/functions', 'reference/divergences', 'reference/api'],
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
              { text: 'Cypher', link: '/reference/cypher' },
              { text: 'Functions', link: '/reference/functions' },
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
          { text: 'Cypher', link: '/reference/cypher' },
          { text: 'Functions', link: '/reference/functions' },
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
