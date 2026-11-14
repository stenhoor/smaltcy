import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import { defineAsyncComponent } from 'vue'
import './smaltdb.css'
import './smaltcy.css'
import { withSmaltworks } from './stage'
import { enableRunnable } from './runnable'

export default {
  extends: DefaultTheme,
  Layout: withSmaltworks({ Layout: DefaultTheme.Layout }),
  enhanceApp({ app }) {
    if (typeof document !== 'undefined') enableRunnable(import.meta.env.BASE_URL)
    // The playground loads only on its page: it pulls in the engine and the GPU renderer.
    app.component('Playground', defineAsyncComponent(() => import('./components/Playground.vue')))
    app.component('TechDemo', defineAsyncComponent(() => import('./components/TechDemo.vue')))
  },
} satisfies Theme
