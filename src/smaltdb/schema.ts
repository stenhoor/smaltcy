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
}

/** A graph to load: GraphJSON's shape (`dumpGraph` in `@smaltworks/smaltcy/engine` gives one). */
export interface GraphData {
  readonly nodes: readonly {
    readonly id: string | number;
    readonly labels?: readonly string[];
    readonly properties?: Readonly<Record<string, PropertyValue>>;
  }[];
  readonly relationships: readonly {
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
export function graphTables(labels: readonly string[], types: readonly string[], graph = 'graph'): GraphTables {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(graph)) unsupported(`A graph's name is a plain identifier, not ${JSON.stringify(graph)}`);
  // smaltdb finds a graph's labels and types ignoring case (`addLabel`); Cypher's are case-sensitive.
  const once = (names: readonly string[], what: string) => {
    const seen = new Map<string, string>();
    for (const n of names) {
      const other = seen.get(n.toLowerCase());
      if (other !== undefined && other !== n) unsupported(`The ${what}s ${other} and ${n} differ only in case, which a smaltdb property graph can't hold`);
      seen.set(n.toLowerCase(), n);
    }
    return [...new Set(names)];
  };
  const ls = once(labels, 'label');
  const ts = once(types, 'relationship type');
  if (ls.some((l) => l.toLowerCase() === NODE_LABEL)) unsupported(`The label ${NODE_LABEL} is reserved`);
  return {
    graph,
    nodes: `${graph}_node`,
    labels: `${graph}_labels`,
    labelTables: new Map(ls.map((l, k) => [l, `${graph}_l${k}`])),
    types: new Map(ts.map((t, k) => [t, `${graph}_t${k}`])),
  };
}

/** The tables of a graph to load: its labels and types, in the order they first appear. */
export function graphTablesFor(data: GraphData, graph = 'graph'): GraphTables {
  return graphTables(
    data.nodes.flatMap((n) => n.labels ?? []),
    data.relationships.map((r) => r.type),
    graph,
  );
}

const schema = (op: plan.SchemaOp): PlanStatementInput => ({ kind: 'schema', op }) as PlanStatementInput;

/** The statements that make the graph's tables and property graph, run in order on an empty database. */
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
  } as plan.TableDef;
  const alter = (action: Extract<plan.SchemaOp, { op: 'alterPropertyGraph' }>['action']) => schema({ op: 'alterPropertyGraph', name: t.graph, action });
  return [
    schema({ op: 'createTable', table: nodeTable, temp: false, ifNotExists: false } as plan.SchemaOp),
    schema({ op: 'createPropertyGraph', ifNotExists: false, graph: { name: t.graph, nodes: [{ label: NODE_LABEL, table: t.nodes, id: 'id', props: 'props' }], edges: [] } }),
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
  const edges = new Map<string, { start: number[]; end: number[]; props: Record<string, PropertyValue>[] }>();
  for (const r of data.relationships) {
    const s = ids.get(r.start);
    const e = ids.get(r.end);
    if (s === undefined || e === undefined) throw new SmaltcyError('SMALTCY_NOT_FOUND', `A ${r.type} relationship refers to a node that isn't in the graph (${s === undefined ? r.start : r.end})`);
    const table = t.types.get(r.type) ?? unsupported(`The relationship type ${r.type} is not one of the graph's`);
    let rows = edges.get(table);
    if (!rows) edges.set(table, (rows = { start: [], end: [], props: [] }));
    rows.start.push(s);
    rows.end.push(e);
    rows.props.push(propertyMap(r.properties));
  }
  const values = (columns: readonly plan.ValueColumn[], types: readonly plan.PlanType[]): plan.PlanOp => ({ op: 'values', rows: [], types, columns });
  const append = (table: string, input: plan.PlanOp, columns: readonly number[]): PlanStatementInput => ({ kind: 'write', plan: { op: 'append', table, db: 'main', input, columns, upserts: [] } as plan.PlanOp });
  const out: PlanStatementInput[] = [];
  if (nodeIds.length) out.push(append(t.nodes, values([nodeIds, props], ['int', 'map<text, any>']), [0, 1]));
  if (labelNodes.length) out.push(append(t.labels, values([labelNodes, labelNames], ['int', 'text']), [0, 1]));
  for (const [table, rows] of edges) out.push(append(table, values([rows.start, rows.end, rows.props], ['int', 'int', 'map<text, any>']), [0, 1, 2]));
  return out;
}

/** A node's or relationship's properties as a `map<text, any>` value: NULL properties are absent, as in a store. */
function propertyMap(p: Readonly<Record<string, PropertyValue>> | undefined): Record<string, PropertyValue> {
  const out: Record<string, PropertyValue> = {};
  for (const [k, v] of Object.entries(p ?? {})) if (v !== null && v !== undefined) out[k] = v;
  return out;
}
