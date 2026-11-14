# Examples

Every query on this page runs in the tests against the sample social graph (`social()` from
`@smaltworks/smaltcy/datasets`): people, the cities they live in, the topics they like, and who knows whom.

## Finding things

People born after 1930, youngest first:

```cypher
MATCH (p:Person)
WHERE p.born > 1930
RETURN p.name, p.born
ORDER BY p.born DESC
```

| p.name | p.born |
| --- | --- |
| Tim | 1955 |
| Radia | 1951 |
| Ken | 1943 |
| Barbara | 1939 |
| Donald | 1938 |
| Margaret | 1936 |
| Frances | 1932 |

Names that start with A:

```cypher
MATCH (p:Person) WHERE p.name STARTS WITH 'A' RETURN p.name
```

| p.name |
| --- |
| Ada |
| Alan |

## Following relationships

Who Ada knows, and who they know:

```cypher
MATCH (:Person {name: 'Ada'})-[:KNOWS]->(friend)-[:KNOWS]->(fof)
RETURN friend.name, fof.name
```

| friend.name | fof.name |
| --- | --- |
| Alan | Grace |
| Alan | Edsger |

Everyone within three steps, in either direction, each once:

```cypher
MATCH (:Person {name: 'Ada'})-[:KNOWS*1..3]-(p)
RETURN DISTINCT p.name
```

| p.name |
| --- |
| Alan |
| Grace |
| Edsger |
| Frances |
| Barbara |
| Donald |

People in the same city who like the same topic:

```cypher
MATCH (a:Person)-[:LIVES_IN]->(c)<-[:LIVES_IN]-(b:Person),
      (a)-[:LIKES]->(t)<-[:LIKES]-(b)
WHERE a.name < b.name
RETURN a.name, b.name, c.name AS city, t.name AS topic
```

| a.name | b.name | city | topic |
| --- | --- | --- | --- |
| Ada | Alan | London | Algorithms |
| Frances | Grace | New York | Compilers |
| John | Ken | Palo Alto | Languages |

## Paths

The shortest chain of acquaintances between two people:

```cypher
MATCH (a:Person {name: 'Ada'}), (b:Person {name: 'Radia'})
MATCH p = shortestPath((a)-[:KNOWS*]-(b))
RETURN [n IN nodes(p) | n.name] AS chain, length(p) AS steps
```

| chain | steps |
| --- | --- |
| ["Ada","Alan","Edsger","Barbara","Radia"] | 4 |

## Counting and grouping

How many people live in each city:

```cypher
MATCH (p:Person)-[:LIVES_IN]->(c:City)
RETURN c.name AS city, count(p) AS people
ORDER BY people DESC, city
```

| city | people |
| --- | --- |
| London | 3 |
| New York | 3 |
| Palo Alto | 3 |
| Boston | 2 |
| Austin | 1 |

Topics with the people who like them:

```cypher
MATCH (p:Person)-[:LIKES]->(t:Topic)
RETURN t.name AS topic, collect(p.name) AS people
```

| topic | people |
| --- | --- |
| Compilers | ["Grace","Frances","Margaret"] |
| Graphs | ["Edsger"] |
| Networks | ["Radia","Tim"] |
| Algorithms | ["Ada","Alan","Donald","Edsger"] |
| Languages | ["Barbara","John","Ken"] |

People with more than one acquaintance, using `WITH` to filter on a count:

```cypher
MATCH (p:Person)-[:KNOWS]-(other)
WITH p, count(other) AS n
WHERE n > 1
RETURN p.name, n
ORDER BY n DESC
```

| p.name | n |
| --- | --- |
| Edsger | 4 |
| Alan | 3 |
| Grace | 3 |
| Barbara | 3 |
| Donald | 3 |
| Radia | 3 |
| Frances | 2 |
| John | 2 |
| Ken | 2 |

## Optional parts

Everyone, with the topics they like if any:

```cypher
MATCH (p:Person)
OPTIONAL MATCH (p)-[:LIKES]->(t)
RETURN p.name, t.name
```

| p.name | t.name |
| --- | --- |
| Ada | Algorithms |
| Alan | Algorithms |
| Grace | Compilers |
| Edsger | Graphs |
| Edsger | Algorithms |
| … 8 more rows | |

## Patterns as conditions

People who don't know anyone in their own city:

```cypher
MATCH (p:Person)-[:LIVES_IN]->(c)
WHERE NOT EXISTS { MATCH (p)-[:KNOWS]-(q)-[:LIVES_IN]->(c) }
RETURN p.name, c.name
```

| p.name | c.name |
| --- | --- |
| Edsger | Austin |
| Tim | London |

## Changing the graph

Add a person and connect them:

```cypher
MATCH (ada:Person {name: 'Ada'})
CREATE (you:Person {name: 'You', born: 2000})-[:KNOWS {since: 2026}]->(ada)
RETURN you.name
```

| you.name |
| --- |
| You |

Create a topic only if it isn't there, then link to it:

```cypher
MERGE (t:Topic {name: 'Databases'})
  ON CREATE SET t.created = timestamp()
WITH t
MATCH (p:Person {name: 'Barbara'})
MERGE (p)-[:LIKES]->(t)
```

Update and remove properties and labels:

```cypher
MATCH (p:Person {name: 'Grace'})
SET p:Admiral, p.title = 'Rear Admiral'
REMOVE p.born
```

Delete a person and their relationships:

```cypher
MATCH (p:Person {name: 'Tim'}) DETACH DELETE p
```
