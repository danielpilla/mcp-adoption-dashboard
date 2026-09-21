# Third-party notices

This distribution includes the following direct runtime dependencies. They
remain governed by their upstream licenses and are not relicensed by this
project.

| Package          | Resolved version | License      | Source                                               |
| ---------------- | ---------------: | ------------ | ---------------------------------------------------- |
| d3               |            7.9.0 | ISC          | <https://github.com/d3/d3>                           |
| d3-sankey        |           0.12.3 | BSD-3-Clause | <https://github.com/d3/d3-sankey>                    |
| express          |            5.2.1 | MIT          | <https://github.com/expressjs/express>               |
| react            |           19.3.0 | MIT          | <https://github.com/facebook/react>                  |
| react-dom        |           19.3.0 | MIT          | <https://github.com/facebook/react>                  |
| write-excel-file |            4.1.1 | MIT          | <https://gitlab.com/catamphetamine/write-excel-file> |

Resolved transitive versions and license identifiers are recorded in
`package-lock.json` and the installed package metadata. To produce a local
inventory from the locked dependency tree:

```bash
npm query ':root > *' | node -e \
  "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.table(JSON.parse(s).map(({name,version,license,links})=>({name,version,license,repository:links?.repository}))))"
```

The full upstream license text for each installed package is included in that
package when provided by its publisher. Source repositories above are the
authoritative location for copyright notices and license terms.
