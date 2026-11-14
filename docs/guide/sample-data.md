# Sample data

Every example in these docs runs where it stands, on one of these graphs: press **Run**, and the result shows as a
table and, when it holds nodes, relationships or paths, as a graph drawn on the GPU. The table printed under an
example is its tested result. **Edit** changes the query. Each Run starts from the dataset as generated, plus what the
examples above it on the same page and dataset write, so nothing a Run writes stays. The same datasets are in
`@smaltworks/smaltcy/datasets`, and in the [playground](/playground).

## Social

Twelve people, the cities they live in, the topics they like, and who knows whom. Most examples in these docs use
it.

```cypher
MATCH (p:Person)-[r]->(x)
RETURN p, r, x
```

| p | r | x |
| --- | --- | --- |
| (:Person {"name":"Ada","born":1815}) | [:LIVES_IN] | (:City {"name":"London"}) |
| (:Person {"name":"Ada","born":1815}) | [:KNOWS {"since":1833}] | (:Person {"name":"Alan","born":1912}) |
| (:Person {"name":"Ada","born":1815}) | [:LIKES] | (:Topic {"name":"Algorithms"}) |
| (:Person {"name":"Alan","born":1912}) | [:LIVES_IN] | (:City {"name":"London"}) |
| (:Person {"name":"Alan","born":1912}) | [:KNOWS {"since":1936}] | (:Person {"name":"Grace","born":1906}) |
| … 34 more rows | | |

Who is two steps from Ada, and how:

```cypher
MATCH path = (:Person {name: 'Ada'})-[:KNOWS*1..2]-(p:Person)
RETURN path
```

| path |
| --- |
| Ada → Alan |
| Ada → Alan → Grace |
| Ada → Alan → Edsger |

## The smalt family

The smalt products, what each is built on, and who uses them.

```cypher dataset=family
MATCH (a)-[r]->(b)
RETURN a, r, b
```

| a | r | b |
| --- | --- | --- |
| (:Product:Engine {"name":"smaltdb","line":"A fast alternative database for the browser, written in TypeScript."}) | [:RUNS_ON] | (:Platform {"name":"OPFS"}) |
| (:Product:Engine {"name":"smaltdb","line":"A fast alternative database for the browser, written in TypeScript."}) | [:RUNS_ON] | (:Platform {"name":"Web Workers"}) |
| (:Product:Language {"name":"smaltql","line":"The SQL you know, for smaltdb."}) | [:BUILT_ON] | (:Product:Engine {"name":"smaltdb","line":"A fast alternative database for the browser, written in TypeScript."}) |
| (:Product:Language {"name":"smaltdf","line":"Dataframes for smaltdb. Small and fast."}) | [:BUILT_ON] | (:Product:Engine {"name":"smaltdb","line":"A fast alternative database for the browser, written in TypeScript."}) |
| (:Product:Language {"name":"smaltcy","line":"A graph database for the browser that speaks Cypher."}) | [:RUNS_ON] | (:Platform {"name":"Web Workers"}) |
| … 20 more rows | | |

Everything an analyst reaches in up to three steps:

```cypher dataset=family
MATCH path = (:Role {name: 'Analyst'})-[*1..3]->(x)
RETURN path
```

| path |
| --- |
| Analyst → smaltbi |
| Analyst → smaltbi → smaltdb |
| Analyst → smaltbi → smaltdb → OPFS |
| Analyst → smaltbi → smaltdb → Web Workers |
| Analyst → smaltbi → smaltql |
| … 11 more rows |

## Metro

A made-up metro: 8 lines of 30 stops across a city, with transfers where lines meet. Each `CONNECTS` relationship
has its line and the minutes it takes.

```cypher dataset=metro
MATCH (a:Station)-[c:CONNECTS]->(b:Station)
WHERE id(a) < id(b)
RETURN a, c, b
```

| a | c | b |
| --- | --- | --- |
| (:Station {"name":"Rokami","x":0,"y":4}) | [:CONNECTS {"line":"Line 1","minutes":2}] | (:Station {"name":"Velan","x":0,"y":3}) |
| (:Station {"name":"Velan","x":0,"y":3}) | [:CONNECTS {"line":"Line 1","minutes":1}] | (:Station {"name":"Hamrovel","x":0,"y":2}) |
| (:Station {"name":"Hamrovel","x":0,"y":2}) | [:CONNECTS {"line":"Line 1","minutes":3}] | (:Station {"name":"Loantu","x":0,"y":1}) |
| (:Station {"name":"Loantu","x":0,"y":1}) | [:CONNECTS {"line":"Line 1","minutes":4}] | (:Station {"name":"Fordloton","x":0,"y":0}) |
| (:Station {"name":"Fordloton","x":0,"y":0}) | [:CONNECTS {"line":"Line 2","minutes":3}] | (:Station {"name":"Mian","x":1,"y":0}) |
| … 153 more rows | | |

The route with the fewest stops from one end of Line 1 to the other:

```cypher dataset=metro
MATCH (:Line {name: 'Line 1'})<-[:ON]-(s)
WITH collect(s) AS stops
WITH stops[0] AS a, stops[-1] AS b
MATCH p = shortestPath((a)-[:CONNECTS*]->(b))
RETURN p
```

| p |
| --- |
| Rokami → Velan → Hamrovel → Loantu → Fordloton |

Stations where you can change lines:

```cypher dataset=metro
MATCH (s:Station)-[:ON]->(l:Line)
WITH s, collect(DISTINCT l.name) AS lines
WHERE size(lines) > 1
RETURN s.name AS station, lines
ORDER BY size(lines) DESC, station
```

| station | lines |
| --- | --- |
| Andovel | ["Line 3","Line 5"] |
| Anmi | ["Line 3","Line 5"] |
| Dogatetu | ["Line 4","Line 8"] |
| Doloford | ["Line 3","Line 5"] |
| Fordloton | ["Line 1","Line 2"] |
| Gatefordlo | ["Line 3","Line 5"] |
| Gatesaro | ["Line 3","Line 5"] |
| Gatetonis | ["Line 4","Line 8"] |
| Hamloan | ["Line 3","Line 5"] |
| Sahamro | ["Line 3","Line 5"] |
| Tugatetu | ["Line 4","Line 8"] |

## Network

People who know each other, grown by preferential attachment: the well-connected make more friends, mostly in their
own community. The examples here run on 2,000 people; the [tech demo](/demo) draws up to 100,000.

```cypher dataset=network
MATCH path = (:Person {name: 'Bo 1'})-[:KNOWS*1..2]-(f)
RETURN path
LIMIT 300
```

| path |
| --- |
| Bo 1 → Ana 0 |
| Bo 1 → Ana 0 → Dara 3 |
| Bo 1 → Ana 0 → Femi 5 |
| Bo 1 → Ana 0 → Gus 6 |
| Bo 1 → Ana 0 → Pia 15 |
| … 295 more rows |

The best-connected people and their communities:

```cypher dataset=network
MATCH (p:Person)-[:KNOWS]-(f)
RETURN p.name AS name, p.community AS community, count(f) AS friends
ORDER BY friends DESC
LIMIT 10
```

| name | community | friends |
| --- | --- | --- |
| Bo 1 | 5 | 49 |
| Jun 9 | 0 | 46 |
| Ana 0 | 0 | 41 |
| Uma 20 | 2 | 40 |
| Sol 18 | 1 | 36 |
| Chen 27 | 3 | 33 |
| Sol 43 | 0 | 33 |
| Femi 5 | 0 | 32 |
| Hana 7 | 5 | 32 |
| Chen 2 | 3 | 31 |

How far apart two people are:

```cypher dataset=network
MATCH (a:Person {name: 'Bo 1'}), (b:Person {name: 'Gus 6'})
MATCH p = shortestPath((a)-[:KNOWS*]-(b))
RETURN p
```

| p |
| --- |
| Bo 1 → Gus 6 |

## Real-world shapes

Seven more generated graphs, each with the shape of a real system, so a query or a drawing looks like a problem you
know. Each takes a size and a seed, is the same every time for them, and can come with its growth as history: a
commit per hire, publish, flight route or deploy. The examples here run on 300 nodes; the [tech demo](/demo) draws
each from 50 to 100,000.

```ts
import { open } from '@smaltworks/smaltcy';
import { orgChart, packages } from '@smaltworks/smaltcy/datasets';

const company = open();
company.load(orgChart(1000));

// With its growth: a commit per package published.
const registry = open({ history: true });
registry.load(packages(5000, { seed: 3, history: true }));
```

| Function | A graph like | Shape | Labels and relationships |
| --- | --- | --- | --- |
| `orgChart` | A company's reporting lines | A deep tree: about one relationship per person | `:Employee`, `REPORTS_TO`, `MENTORS` |
| `packages` | npm: packages and what they depend on | A few hubs under thousands, most with no dependents | `:Package`, `DEPENDS_ON` |
| `airline` | Airline routes | Hub and spoke: stars joined at their centres | `:Airport:Hub`, `ROUTE {airline, km}` |
| `powerGrid` | A power grid on a map | Spread out: a few links each, long paths | `:Substation`, `:Plant`, `LINE {kV, km}`, `FEEDS` |
| `gitHistory` | A repository's commits | Long chains that fork and merge | `:Commit:Merge`, `PARENT` |
| `supplyChain` | Suppliers to stores | Five tiers, four hops deep | `:Supplier` … `:Store`, `SUPPLIES {product, leadDays}` |
| `microservices` | Services, their calls and databases | Tight team clusters, few bridges | `:Service:Gateway`, `:Database`, `CALLS`, `USES` |

### Org chart

The chain of command from the newest hire up to the CEO:

```cypher dataset=org-chart
MATCH (e:Employee)
WITH e ORDER BY id(e) DESC LIMIT 1
MATCH p = (e)-[:REPORTS_TO*]->(:Employee {level: 0})
RETURN p
```

| p |
| --- |
| Tara Petrov → Umar Mensah → Rosa Byrne 2 → Quinn Kowalski → Sven Duarte → Ada Tanaka |

### Package dependencies

The most depended-on packages:

```cypher dataset=packages
MATCH (p:Package)<-[:DEPENDS_ON]-(d)
RETURN p.name AS package, count(d) AS dependents
ORDER BY dependents DESC
LIMIT 5
```

| package | dependents |
| --- | --- |
| router-web | 45 |
| glob-parse | 36 |
| color-tiny | 28 |
| micro-parse | 27 |
| lint-queue | 23 |

### Airline routes

The fewest flights between the first airport and the newest:

```cypher dataset=airline
MATCH (b:Airport)
WITH b ORDER BY id(b) DESC LIMIT 1
MATCH (a:Airport {code: 'AAA'})
MATCH p = shortestPath((a)-[:ROUTE*]-(b))
RETURN p
```

| p |
| --- |
| AAA International → AAE International → ALN Regional |

### Power grid

Every substation within three lines of the first one built:

```cypher dataset=power-grid
MATCH (a:Substation)
WITH a ORDER BY id(a) LIMIT 1
MATCH p = (a)-[:LINE*1..3]-(n)
RETURN p
LIMIT 200
```

| p |
| --- |
| Central 0001 → Central 0002 |
| Central 0001 → Central 0002 → Central 0003 |
| Central 0001 → Central 0002 → Central 0003 → Central 0004 |
| Central 0001 → Central 0002 → Central 0003 → Central 0006 |
| Central 0001 → Central 0002 → Central 0003 → Central 0007 |
| … 31 more rows |

### Git history

The merges, and the branch each brought in:

```cypher dataset=git-history
MATCH (m:Merge)-[:PARENT]->(c:Commit)
WHERE c.branch <> 'main'
RETURN m.hash AS merge, c.branch AS branch, m.author AS author
```

| merge | branch | author |
| --- | --- | --- |
| d2c201e | feature/search-1 | dara |
| 5c9bdd6 | fix/API-5 | bo |
| 6f41dac | feature/logging-2 | ana |
| 6529e8e | fix/cache-6 | ana |
| 39737cf | fix/login-9 | chen |
| … 26 more rows | | |

### Supply chain

Where one store's goods come from, four hops back:

```cypher dataset=supply-chain
MATCH (s:Store)
WITH s LIMIT 1
MATCH p = (:Supplier)-[:SUPPLIES*4]->(s)
RETURN p
```

| p |
| --- |
| Ironvale Mining 1 → Precision Parts 1 → Assembly Plant Quito 1 → Distribution Centre Tallinn 1 → Store #1 Seoul |
| Copperline 2 → Precision Parts 1 → Assembly Plant Quito 1 → Distribution Centre Tallinn 1 → Store #1 Seoul |
| Cobalt Ridge 1 → Glassworks 1 → Assembly Plant Quito 1 → Distribution Centre Tallinn 1 → Store #1 Seoul |
| Silica Sands 3 → Glassworks 1 → Assembly Plant Quito 1 → Distribution Centre Tallinn 1 → Store #1 Seoul |
| Copperline 1 → Circuit Co 1 → Assembly Plant Quito 1 → Distribution Centre Tallinn 1 → Store #1 Seoul |
| … 12 more rows |

### Microservices

The calls that cross from one team to another:

```cypher dataset=microservices
MATCH (a:Service)-[c:CALLS]->(b:Service)
WHERE a.team <> b.team
RETURN a, c, b
```

| a | c | b |
| --- | --- | --- |
| (:Service:Gateway {"name":"payments-gateway","team":"payments","language":"go"}) | [:CALLS {"rpm":3323}] | (:Service:Gateway {"name":"checkout-gateway","team":"checkout","language":"go"}) |
| (:Service:Gateway {"name":"search-gateway","team":"search","language":"go"}) | [:CALLS {"rpm":1838}] | (:Service:Gateway {"name":"checkout-gateway","team":"checkout","language":"go"}) |
| (:Service:Gateway {"name":"catalog-gateway","team":"catalog","language":"go"}) | [:CALLS {"rpm":2141}] | (:Service:Gateway {"name":"checkout-gateway","team":"checkout","language":"go"}) |
| (:Service:Gateway {"name":"accounts-gateway","team":"accounts","language":"go"}) | [:CALLS {"rpm":3649}] | (:Service:Gateway {"name":"catalog-gateway","team":"catalog","language":"go"}) |
| (:Service:Gateway {"name":"shipping-gateway","team":"shipping","language":"go"}) | [:CALLS {"rpm":603}] | (:Service:Gateway {"name":"payments-gateway","team":"payments","language":"go"}) |
| … 24 more rows | | |
