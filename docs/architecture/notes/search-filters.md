# Scoped content search

`GET /api/search?q=build+and+test&limit=20&source=specs&type=decision`
accepts optional exact source-name and effective concept-type filters. Empty
filters mean all; unknown values return no hits. Both filters combine with AND.
They apply before the result limit, so a source's relevant documents remain
findable even when other sources fill the global top 20.

Source membership includes any contribution to the concept, including one
whose text does not match the query. Type follows the resolver's frontmatter
cascade, including inherited values, date ties and full overrides; an absent
type is `concept`. This matches the Library view's facets.

Filtering retains the complete indexed corpus for BM25F statistics and the
best matching contribution for each hit. A surviving hit keeps its original
score, snippet and matching layers. The source index stays warm across filter
changes, and the bounded response memo keys on query, limit and both filters.
The existing `indexing` and `indexingSources` fields still report partial
coverage across the selected profile.
