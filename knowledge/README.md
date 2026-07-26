# knowledge/

`import-knowledge` writes `reverse-index.json` here — an index of a local
markdown corpus (titles, tags, summaries, and absolute paths) that
`knowledge_search` / `/know` answer from.

The index is deliberately **not** committed: it points at files on the
operator's own disk and carries excerpts of them.

```bash
go run ./cmd/import-knowledge                      # defaults to ~/frida/reverse-engineering
go run ./cmd/import-knowledge ~/notes/re ~/wiki    # or any set of files and directories
```
