import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import { defineAsyncComponent } from 'vue'
import './smaltdb.css'
import './smaltcy.css'
import { withSmaltworks } from './stage'
import { enablePlaygrounds } from './playground'
import { cypherRunner } from './cypher'

export default {
  extends: DefaultTheme,
  Layout: withSmaltworks({ Layout: DefaultTheme.Layout }),
  enhanceApp({ app }) {
    // Every cypher example runs where it stands (BRAND.md, Documentation, rule 7), on its sample dataset (theme/cypher.ts).
    if (typeof document !== 'undefined') enablePlaygrounds({ runners: { cypher: cypherRunner() } })
    // The playground loads only on its page: it pulls in the engine and the GPU renderer.
    app.component('Playground', defineAsyncComponent(() => import('./components/Playground.vue')))
    app.component('TechDemo', defineAsyncComponent(() => import('./components/TechDemo.vue')))
  },
} satisfies Theme
