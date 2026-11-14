---
description: 'RETURN is the result of a query: its columns, DISTINCT, aggregates, ORDER BY, SKIP and LIMIT.'
---

# RETURN

`RETURN` says what a query gives: one column for each item. It is the last clause of a reading query.

## Syntax

```railroad
return-clause
projection
return-item
order-by
sort-item
```

## Columns

A column is named by its `AS`, or by the text of its expression. `*` returns every variable in scope.

```cypher
MATCH (p:Person {name: 'Ada'})-[k:KNOWS]->(q)
RETURN p.name, q.name AS friend, k.since - p.born AS age_then
```

| p.name | friend | age_then |
| --- | --- | --- |
| Ada | Alan | 18 |

```cypher
MATCH (p:Person {name: 'Ada'})-[:LIVES_IN]->(c)
RETURN *
```

| c | p |
| --- | --- |
| (:City {"name":"London"}) | (:Person {"name":"Ada","born":1815}) |

## Aggregates

An item with an aggregate (`count`, `sum`, `avg`, `min`, `max`, `collect`, `stDev`, `stDevP`) makes one row for each
group: the items without an aggregate are the group's key. With no key, there is one row for all of them.

```cypher
MATCH (p:Person)-[:LIVES_IN]->(c:City)
RETURN c.name AS city, count(*) AS people, min(p.born) AS oldest, collect(p.name) AS names
ORDER BY people DESC, city
```

| city | people | oldest | names |
| --- | --- | --- | --- |
| London | 3 | 1815 | ["Ada","Alan","Tim"] |
| New York | 3 | 1906 | ["Grace","Barbara","Frances"] |
| Palo Alto | 3 | 1927 | ["Donald","John","Ken"] |
| Boston | 2 | 1936 | ["Margaret","Radia"] |
| Austin | 1 | 1930 | ["Edsger"] |

```cypher
MATCH (p:Person)
RETURN count(*) AS people, avg(p.born) AS mean_born, count(DISTINCT p.born / 10) AS decades
```

| people | mean_born | decades |
| --- | --- | --- |
| 12 | 1923.666666666667 | 7 |

`DISTINCT` inside an aggregate counts each value once, and an aggregate skips `null`.

## DISTINCT

`RETURN DISTINCT` drops repeated rows.

```cypher
MATCH (:Person)-[:LIKES]->(t:Topic)
RETURN DISTINCT t.name AS topic
ORDER BY topic
```

| topic |
| --- |
| Algorithms |
| Compilers |
| Graphs |
| Languages |
| Networks |

## ORDER BY, SKIP and LIMIT

`ORDER BY` sorts the rows, ascending unless `DESC`; `null` sorts last ascending, first descending. It may use the
returned columns by their names, or the variables in scope. `SKIP n` drops the first `n` rows and `LIMIT n` keeps at
most `n`; both take a number or a parameter.

```cypher
MATCH (p:Person)
RETURN p.name AS name, p.born AS born
ORDER BY born DESC, name
SKIP 2 LIMIT 3
```

| name | born |
| --- | --- |
| Ken | 1943 |
| Barbara | 1939 |
| Donald | 1938 |

## Errors

`RETURN` must be the last clause:

<!-- docs:error SMALTCY_SEMANTIC -->
```cypher
MATCH (p:Person) RETURN p.name MATCH (q) RETURN q
```

Two columns can't have the same name:

<!-- docs:error SMALTCY_SEMANTIC -->
```cypher
MATCH (p:Person) RETURN p.name AS n, p.born AS n
```

`ORDER BY` can use an aggregate only when it is also returned:

<!-- docs:error SMALTCY_SEMANTIC -->
```cypher
MATCH (p:Person)-[:LIVES_IN]->(c) RETURN c.name ORDER BY count(*)
```

## Working demo

```cypher dataset=empty
UNWIND [['Ann', 'Sales', 52000], ['Ben', 'Sales', 48000], ['Cat', 'Ops', 61000], ['Dan', 'Ops', 58000], ['Eve', 'Legal', 70000]] AS row
CREATE (:Employee {name: row[0], team: row[1], salary: row[2]});
MATCH (e:Employee)
RETURN e.team AS team, count(*) AS people, sum(e.salary) AS payroll, max(e.salary) AS top
ORDER BY payroll DESC
LIMIT 2
```

| team | people | payroll | top |
| --- | --- | --- | --- |
| Ops | 2 | 119000 | 61000 |
| Sales | 2 | 100000 | 52000 |

## See also

- [WITH](./with): the same projection, in the middle of a query.
- [UNION](./union): the rows of several queries together.
- [Functions](../functions): the aggregates and the rest.
