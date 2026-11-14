// smaltcy's runner for the site kit's playgrounds (playground.ts, BRAND.md, Documentation, rule 7). Not a kit file.
//
// Every ```cypher example runs where it stands, on a sample dataset: the fence's `dataset=…`, else the page's front
// matter `play: { dataset }`, else `social`. Its setup is the examples above it on the same dataset that write, run in
// order on a fresh copy of the dataset: what they wrote is there, and nothing else is. A result that holds nodes,
// relationships or paths is drawn under its table by the GPU renderer.
//
// test/docs-examples.test.ts runs every example the same way (datasetOf, setupFor) and checks its printed result.
import type { Attributes, PlayResult, Runner, SetupStep } from './playground'
import type { GraphClient } from '../../../src/worker/client'
import type { GraphView } from '../../../src/render/index'
import { collect, controlsHint, fmt, toRender } from './graph-results'

export const DATASETS = ['empty', 'social', 'family', 'metro', 'network', 'ontology', 'org-chart', 'packages', 'airline', 'power-grid', 'git-history', 'supply-chain', 'microservices'] as const
export type DatasetName = (typeof DATASETS)[number]
/** Datasets the examples load with their history, for AT VERSION, AT TIME and the temporal functions. */
export const WITH_HISTORY: ReadonlySet<DatasetName> = new Set(['ontology'])
/** The network examples run on 2,000 people: enough to show traversals, quick to load. The real-world shapes on 300
 * nodes: small enough to read. */
export const DATASET_SIZE: Partial<Record<DatasetName, number>> = {
  network: 2000,
  'org-chart': 300,
  packages: 300,
  airline: 300,
  'power-grid': 300,
  'git-history': 300,
  'supply-chain': 300,
  microservices: 300,
}

/** Splits Cypher into statements at semicolons outside strings, quoted names and comments. */
export function statements(text: string): string[] {
  const out: string[] = []
  let start = 0
  let i = 0
  const push = (end: number) => {
    const s = text.slice(start, end).trim()
    if (s && !/^(\/\/[^\n]*\n?|\/\*[\s\S]*?\*\/|\s)*$/.test(s)) out.push(s)
  }
  while (i < text.length) {
    const c = text[i]
    if (c === "'" || c === '"' || c === '`') {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === '\\' && c !== '`') i++
      i++
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end < 0 ? text.length : end + 2
    } else if (c === ';') {
      push(i)
      start = ++i
    } else i++
  }
  push(text.length)
  return out
}

/** The dataset an example runs on, from its attributes. `empty` is a graph with nothing in it. */
export function datasetOf(attrs: Attributes): DatasetName {
  const name = attrs.dataset ?? 'social'
  if (!(DATASETS as readonly string[]).includes(name)) throw new Error(`Unknown dataset ${name} for a cypher example`)
  return name as DatasetName
}

/** A value as a result grid shows it: nodes, relationships, paths, lists and maps as text; the rest as they are. */
export const cell = (v: unknown): unknown => (v !== null && typeof v === 'object' ? fmt(v) : v)

/** A value as a printed result shows it, in the Markdown table under an example: as the grid shows it. */
export function printed(v: unknown): string {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'number' && !Number.isInteger(v)) return String(Math.round(v * 1e12) / 1e12)
  return fmt(v).replace(/\|/g, '\\|')
}

const WRITES = /\b(CREATE|MERGE|SET|DELETE|REMOVE|DROP)\b/i

/** The setup steps an example runs first: those above it on its dataset that write. Reads change nothing. */
export function setupFor(setup: readonly SetupStep[], dataset: DatasetName): { code: string; fails: boolean }[] {
  return setup.flatMap((s) => {
    const step = typeof s === 'string' ? { sql: s } : s
    const on = datasetOf(step.attrs ?? {})
    return on === dataset && WRITES.test(step.sql) ? [{ code: step.sql, fails: !!step.fails }] : []
  })
}

// ---------------------------------------------------------------------------------------------------------------------
// In the browser

/** Views kept drawing at once: each holds a GPU context. Older ones give their canvas back. */
const MAX_VIEWS = 4
const views: { view: GraphView; panel: HTMLElement }[] = []
const isDark = () => document.documentElement.classList.contains('dark')
let themed = false

/** One engine for the visit, in a Web Worker, started on the first Run. */
export function cypherRunner(): () => Promise<Runner> {
  return async () => {
    const { connect } = await import('../../../src/worker/client')
    const client: GraphClient = connect(new Worker(new URL('../../../src/worker/worker.ts', import.meta.url), { type: 'module', name: 'smaltcy' }))
    let queue: Promise<unknown> = Promise.resolve()
    const run = async (code: string, setup: SetupStep[], attrs: Attributes): Promise<PlayResult> => {
      const name = datasetOf(attrs)
      const steps = setupFor(setup, name)
      // The dataset as generated: the worker reloads it when a write changed it. The empty graph is the smallest one,
      // emptied.
      if (name === 'empty') {
        await client.dataset({ name: 'family' })
        await client.run('MATCH (n) DETACH DELETE n')
      } else await client.dataset({ name, size: DATASET_SIZE[name], history: WITH_HISTORY.has(name) })
      // A step expected to fail runs up to its failing statement.
      for (const s of steps) {
        try {
          for (const st of statements(s.code)) await client.run(st)
        } catch (e) {
          if (!s.fails) throw e
        }
      }
      const parts = statements(code)
      if (!parts.length) return { columns: [], rows: [], note: 'Nothing to run' }
      for (const st of parts.slice(0, -1)) await client.run(st)
      const r = await client.run(parts[parts.length - 1]!)
      if (r.explain) {
        const plan = String(r.rows[0]?.[0] ?? '')
        return { columns: [], rows: [], note: 'The plan, not run:', render: (host) => void host.append(Object.assign(document.createElement('pre'), { className: 'cy-run-plan', textContent: plan })) }
      }
      if (r.columns.length) return { columns: [...r.columns], rows: r.rows.map((row) => row.map(cell)), render: (host, signal) => draw(host, r.rows, signal) }
      const wrote = Object.entries(r.counts).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k.replace(/([A-Z])/g, ' $1').toLowerCase()}`)
      return { columns: [], rows: [], note: wrote.length ? `Done: ${wrote.join(', ')}` : 'Done: no rows' }
    }
    return {
      run: (code, setup, attrs) => {
        const result = queue.then(() => run(code, setup, attrs))
        queue = result.catch(() => undefined)
        return result
      },
    }
  }
}

/** Draws a result's nodes, relationships and paths under its table. */
async function draw(host: HTMLElement, rows: readonly (readonly unknown[])[], signal: AbortSignal): Promise<void> {
  const drawn = collect(rows)
  if (!drawn) return
  const doc = host.ownerDocument
  const panel = doc.createElement('div')
  panel.className = 'cy-run-graph'
  const canvas = doc.createElement('canvas')
  const bar = doc.createElement('div')
  bar.className = 'cy-run-graph-bar'
  bar.innerHTML =
    `<button type="button" data-mode="2d" class="on">2D</button><button type="button" data-mode="3d">3D</button>` +
    `<button type="button" data-layout="force" class="on" title="Physics">Force</button><button type="button" data-layout="fixed" title="Locked, spread out by group">Fixed</button>` +
    `<input type="range" data-spread min="-100" max="100" value="0" aria-label="Spread: how far apart the nodes are" title="Spread">` +
    `<button type="button" data-fit>Fit</button><span></span>`
  const hint = doc.createElement('div')
  hint.className = 'cy-run-hint'
  const setHint = (mode: '2d' | '3d') => {
    const h = controlsHint(mode)
    hint.innerHTML = `<span class="gc-mouse">${h.mouse}</span><span class="gc-touch">${h.touch}</span>`
  }
  setHint('2d')
  panel.append(canvas, bar, hint)
  host.append(panel)
  const note = (text: string) => panel.replaceChildren(Object.assign(doc.createElement('p'), { className: 'cy-run-note', textContent: text }))
  try {
    const { createGraphView } = await import('../../../src/render/index')
    if (signal.aborted) return
    // Free the oldest view's GPU resources when too many are drawing.
    while (views.length >= MAX_VIEWS) {
      const old = views.shift()!
      old.view.destroy()
      old.panel.querySelector('canvas')?.replaceWith(Object.assign(doc.createElement('p'), { className: 'cy-run-note', textContent: 'Run again to draw this graph.' }))
    }
    const view = await createGraphView(canvas, { theme: isDark() ? 'dark' : 'light', labels: true })
    if (signal.aborted) return view.destroy()
    const entry = { view, panel }
    views.push(entry)
    // The result went (the next Run, Reset or another page): its view goes too.
    signal.addEventListener('abort', () => {
      const i = views.indexOf(entry)
      if (i >= 0) views.splice(i, 1)
      view.destroy()
    })
    if (!themed) {
      themed = true
      new MutationObserver(() => {
        for (const v of views) v.view.setTheme(isDark() ? 'dark' : 'light')
      }).observe(doc.documentElement, { attributes: true, attributeFilter: ['class'] })
    }
    view.setGraph(toRender(drawn))
    bar.querySelector('span')!.textContent = `${drawn.nodes.length} nodes · ${drawn.edges.length} relationships`
    // Spread: logarithmic, 1× in the middle, 0.2× to 5×.
    bar.querySelector<HTMLInputElement>('[data-spread]')!.addEventListener('input', (e) => {
      view.setSpread(Math.exp((Number((e.target as HTMLInputElement).value) / 100) * Math.log(5)))
    })
    bar.addEventListener('click', (e) => {
      const b = (e.target as Element).closest('button')
      if (!b) return
      if (b.hasAttribute('data-fit')) return view.fit()
      const layout = b.getAttribute('data-layout') as 'force' | 'fixed' | null
      if (layout) {
        view.setLayoutMode(layout)
        bar.querySelectorAll('[data-layout]').forEach((x) => x.classList.toggle('on', x === b))
        return
      }
      const mode = b.getAttribute('data-mode') as '2d' | '3d'
      view.setMode(mode)
      setHint(mode)
      bar.querySelectorAll('[data-mode]').forEach((x) => x.classList.toggle('on', x === b))
    })
  } catch (e) {
    note((e as Error).name === 'GpuUnavailableError' ? 'Drawing the graph needs WebGPU, which this browser doesn’t offer.' : `The graph couldn’t be drawn: ${(e as Error).message}`)
  }
}
