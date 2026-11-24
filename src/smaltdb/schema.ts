/**
 * A smaltcy graph in smaltdb (ADR 0004): the schema statements that make its property graph, and the write statements
 * that load a graph into it. Statements are plain plan data (`smaltdb/engine`'s `PlanStatementInput`): smaltdb is not a
 * runtime dependency of smaltcy yet, so nothing here imports its values, only its types.
 *
 * - One property graph per smaltcy graph (default name `graph`).
 * - Every node is a row of one node table, `<graph>_node` (`id INTEGER PRIMARY KEY`, `props map<text, any>`),
 *   registered under the reserved label `smaltcy:node`, which Cypher never shows.
 * - Every Cypher label is a label of the graph (its own table, `<graph>_l<k>`, stays empty) and an entry in the graph's
 *   label index, `<graph>_labels` (`node`, `label`), one row per node and label, in the order the node has them.
 * - One edge table per relationship type, `<graph>_t<k>` (`start`, `end`, `props`), with indexes on `start` and `end`.
 *   A relationship's rowid is its smaltcy id when the graph to load gives them (`id`), so `id(r)` reads the same;
 *   otherwise relationships are numbered from 0 in order, across the tables, and `id(r)` is refused.
 * - A graph that keeps history (`history`, smaltcy's `open({ history })`) is a property graph with smaltdb's
 *   `history`: all its tables keep their past versions, and every commit that writes them is a version.
 */
import type { plan, PlanStatementInput } from 'smaltdb/engine';
import { SmaltcyError } from '../errors.js';
import type { PropertyValue } from '../values.js';

/** The label of the graph's node table: reserved, never a Cypher label. */
export const NODE_LABEL = 'smaltcy:node';

/** Where a smaltcy graph lives in smaltdb: what the compiler reads. */
export interface GraphTables {
  /** The property graph's name. */
  readonly graph: string;
  /** The node table: column 0 `id`, column 1 `props`. */
  readonly nodes: string;
  /** The label index: column 0 `node`, column 1 `label`; its rowid keeps a node's labels in order. */
  readonly labels: string;
  /** Each Cypher label's own table (empty: a node's labels are in the label index). */
  readonly labelTables: ReadonlyMap<string, string>;
  /** Each relationship type's edge table: columns `start`, `end`, `props`. */
  readonly types: ReadonlyMap<string, string>;
  /** Whether a relationship's rowid is its smaltcy id (the graph was loaded with them): what `id(r)` needs. */
  readonly relationshipIds: boolean;
  /**
   * How the graph keeps its history, when it does (smaltdb's `history` on the property graph: every table of the graph
   * keeps it, `versions` being smaltdb's default method): what `AT VERSION`, `AT TIME` and `version()` read.
   */
  readonly history?: 'versions' | 'log';
}

/** A graph to load: GraphJSON's shape (`dumpGraph` in `@smaltworks/smaltcy/engine` gives one). */
export interface GraphData {
  readonly nodes: readonly {
    readonly id: string | number;
    readonly labels?: readonly string[];
    readonly properties?: Readonly<Record<string, PropertyValue>>;
  }[];
  readonly relationships: readonly {
    /** The relationship's id in smaltcy's store, kept as its rowid (`dumpGraph` leaves it out). */
    readonly id?: number;
    readonly start: string | number;
    readonly end: string | number;
    readonly type: string;
    readonly properties?: Readonly<Record<string, PropertyValue>>;
  }[];
}

const unsupported = (msg: string): never => {
  throw new SmaltcyError('SMALTCY_UNSUPPORTED', msg);
};

/** The tables of a graph with these labels and types, named as `schemaStatements` makes them. */
export function graphTables(labels: readonly string[], types: readonly string[], graph = 'graph', relationshipIds = false): GraphTables {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(graph)) unsupported(`A graph's name is a plain identifier, not ${JSON.stringify(graph)}`);
  // smaltdb's property graphs keep labels and types apart by case, as Cypher does (`Person` and `person` are two).
  const ls = [...new Set(labels)];
  const ts = [...new Set(types)];
  if (ls.includes(NODE_LABEL)) unsupported(`The label ${NODE_LABEL} is reserved`);
  return {
    graph,
    nodes: `${graph}_node`,
    labels: `${graph}_labels`,
    labelTables: new Map(ls.map((l, k) => [l, `${graph}_l${k}`])),
    types: new Map(ts.map((t, k) => [t, `${graph}_t${k}`])),
    relationshipIds,
  };
}

/** Whether every relationship to load has an id a rowid can keep: a non-negative integer, given once. */
function keepsRelationshipIds(data: GraphData): boolean {
  const seen = new Set<number>();
  for (const r of data.relationships) {
    if (typeof r.id !== 'number' || !Number.isSafeInteger(r.id) || r.id < 0 || seen.has(r.id)) return false;
    seen.add(r.id);
  }
  return true;
}

/** The tables of a graph to load: its labels and types, in the order they first appear. */
export function graphTablesFor(data: GraphData, graph = 'graph'): GraphTables {
  return graphTables(
    data.nodes.flatMap((n) => n.labels ?? []),
    data.relationships.map((r) => r.type),
    graph,
    keepsRelationshipIds(data),
  );
}

/** The name Cypher is registered with smaltdb under (language.ts): `db.query(text, params, { language: LANGUAGE })`. */
export const LANGUAGE = 'cypher';

/** A property graph as smaltdb's catalog describes it: what `graphTablesIn` reads of it. */
interface CatalogGraph {
  readonly name: string;
  readonly nodes: readonly { readonly label: string; readonly table: string }[];
  readonly edges: readonly { readonly type: string; readonly table: string }[];
  readonly labels?: { readonly table: string };
  readonly history?: 'versions' | 'log';
}

/** smaltdb's catalog, as far as a graph's tables are read from it: `Database.catalog`, or a bind context's. */
export interface GraphCatalog {
  graphs(): readonly CatalogGraph[];
}

/** A graph made as `schemaStatements` makes one: every node in one table under the reserved label, with a label index. */
const isOurs = (g: CatalogGraph): boolean => g.labels !== undefined && g.nodes.some((n) => n.label === NODE_LABEL);

/** What was read of a catalog's graph: the catalog gives the same description until the schema changes. */
const tablesOfGraph = new WeakMap<CatalogGraph, GraphTables>();

/**
 * A graph's tables as smaltdb's catalog has them now, with the labels and types that statements added: the graph
 * named, or the database's only graph made for Cypher. A relationship's rowid is its id (`relationshipIds`): smaltdb
 * gives each new relationship one no other of the graph has.
 */
export function graphTablesIn(catalog: GraphCatalog, graph?: string): GraphTables {
  const all = catalog.graphs();
  // Asked for every statement: the database's one graph, read before, is the common case.
  if (graph === undefined && all.length === 1) {
    const read = tablesOfGraph.get(all[0]!);
    if (read !== undefined) return read;
  }
  let g: CatalogGraph | undefined;
  if (graph !== undefined) {
    const lower = graph.toLowerCase();
    g = all.find((x) => x.name.toLowerCase() === lower);
    if (g === undefined) throw new SmaltcyError('SMALTCY_NOT_FOUND', `The database has no property graph ${graph}`);
    if (!isOurs(g)) unsupported(`The property graph ${g.name} was not made for Cypher (schemaStatements makes one)`);
  } else {
    for (const x of all) {
      if (!isOurs(x)) continue;
      if (g !== undefined) throw new SmaltcyError('SMALTCY_NOT_FOUND', `The database has more than one graph made for Cypher (${g.name}, ${x.name}): register Cypher for one of them by name`);
      g = x;
    }
    if (g === undefined) throw new SmaltcyError('SMALTCY_NOT_FOUND', 'The database has no graph made for Cypher (schemaStatements makes one)');
  }
  let t = tablesOfGraph.get(g);
  if (t === undefined) {
    t = {
      graph: g.name,
      nodes: g.nodes.find((n) => n.label === NODE_LABEL)!.table,
      labels: g.labels!.table,
      labelTables: new Map(g.nodes.filter((n) => n.label !== NODE_LABEL).map((n) => [n.label, n.table])),
      types: new Map(g.edges.map((e) => [e.type, e.table])),
      relationshipIds: true,
      ...(g.history ? { history: g.history } : {}),
    };
    tablesOfGraph.set(g, t);
  }
  return t;
}

const schema = (op: plan.SchemaOp): PlanStatementInput => ({ kind: 'schema', op }) as PlanStatementInput;

/**
 * The statements that make the graph's tables and property graph, run in order on an empty database. With `history`,
 * the node table and the graph keep it, and smaltdb makes the graph's other tables keep it too.
 */
export function schemaStatements(t: GraphTables): PlanStatementInput[] {
  const column = (name: string, type: plan.StorageType, declaredType: string): plan.ColumnDef => ({ name, declaredType, type, notNull: false, collation: 'binary' });
  const nodeTable = {
    name: t.nodes,
    columns: [column('id', 'INTEGER', 'INTEGER'), column('props', 'MAP', 'map<text, any>')],
    // `ofColumn`: the key is the column's own (INTEGER PRIMARY KEY, the rowid), as smaltdb's addLabel makes it.
    keys: [{ kind: 'primaryKey', columns: [{ column: 0, desc: false, collation: 'binary' }], ofColumn: 0 }],
    checks: [],
    foreignKeys: [],
    storage: 'row',
    ...(t.history ? { history: t.history } : {}),
  } as plan.TableDef;
  const alter = (action: Extract<plan.SchemaOp, { op: 'alterPropertyGraph' }>['action']) => schema({ op: 'alterPropertyGraph', name: t.graph, action });
  return [
    schema({ op: 'createTable', table: nodeTable, temp: false, ifNotExists: false } as plan.SchemaOp),
    schema({ op: 'createPropertyGraph', ifNotExists: false, graph: { name: t.graph, nodes: [{ label: NODE_LABEL, table: t.nodes, id: 'id', props: 'props' }], edges: [], ...(t.history ? { history: t.history } : {}) } }),
    alter({ kind: 'addLabelIndex', table: t.labels }),
    ...[...t.labelTables].map(([label, table]) => alter({ kind: 'addLabel', label, table })),
    ...[...t.types].map(([type, table]) => alter({ kind: 'addType', type, table })),
  ];
}

/**
 * The statements that write a graph into its tables (made by `schemaStatements`). Node ids are kept when they are all
 * non-negative integers (a store's ids, so `id(n)` reads the same); otherwise nodes are numbered from 0 in order.
 */
export function loadStatements(data: GraphData, t: GraphTables): PlanStatementInput[] {
  const keep = data.nodes.every((n) => typeof n.id === 'number' && Number.isSafeInteger(n.id) && n.id >= 0);
  const ids = new Map<string | number, number>();
  const nodeIds: number[] = [];
  const props: Record<string, PropertyValue>[] = [];
  const labelNodes: number[] = [];
  const labelNames: string[] = [];
  data.nodes.forEach((n, i) => {
    if (ids.has(n.id)) throw new SmaltcyError('SMALTCY_CONSTRAINT', `Node id ${n.id} appears twice`);
    const id = keep ? (n.id as number) : i;
    ids.set(n.id, id);
    nodeIds.push(id);
    props.push(propertyMap(n.properties));
    for (const l of new Set(n.labels ?? [])) {
      if (!t.labelTables.has(l)) unsupported(`The label ${l} is not one of the graph's`);
      labelNodes.push(id);
      labelNames.push(l);
    }
  });
  const keepRels = keepsRelationshipIds(data);
  const edges = new Map<string, { rowid: number[]; start: number[]; end: number[]; props: Record<string, PropertyValue>[] }>();
  for (const [i, r] of data.relationships.entries()) {
    const s = ids.get(r.start);
    const e = ids.get(r.end);
    if (s === undefined || e === undefined) throw new SmaltcyError('SMALTCY_NOT_FOUND', `A ${r.type} relationship refers to a node that isn't in the graph (${s === undefined ? r.start : r.end})`);
    const table = t.types.get(r.type) ?? unsupported(`The relationship type ${r.type} is not one of the graph's`);
    let rows = edges.get(table);
    if (!rows) edges.set(table, (rows = { rowid: [], start: [], end: [], props: [] }));
    rows.rowid.push(keepRels ? r.id! : i);
    rows.start.push(s);
    rows.end.push(e);
    rows.props.push(propertyMap(r.properties));
  }
  const values = (columns: readonly plan.ValueColumn[], types: readonly plan.PlanType[]): plan.PlanOp => ({ op: 'values', rows: [], types, columns });
  const append = (table: string, input: plan.PlanOp, columns: readonly number[]): PlanStatementInput => ({ kind: 'write', plan: { op: 'append', table, db: 'main', input, columns, upserts: [] } as plan.PlanOp });
  const out: PlanStatementInput[] = [];
  if (nodeIds.length) out.push(append(t.nodes, values([nodeIds, props], ['int', 'map<text, any>']), [0, 1]));
  if (labelNodes.length) out.push(append(t.labels, values([labelNodes, labelNames], ['int', 'text']), [0, 1]));
  for (const [table, rows] of edges) out.push(append(table, values([rows.rowid, rows.start, rows.end, rows.props], ['int', 'int', 'int', 'map<text, any>']), [-1, 0, 1, 2]));
  return out;
}

/** A node's or relationship's properties as a `map<text, any>` value: NULL properties are absent, as in a store. */
function propertyMap(p: Readonly<Record<string, PropertyValue>> | undefined): Record<string, PropertyValue> {
  const out: Record<string, PropertyValue> = {};
  for (const [k, v] of Object.entries(p ?? {})) if (v !== null && v !== undefined) out[k] = v;
  return out;
}
