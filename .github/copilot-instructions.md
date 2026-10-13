<!-- RECURSIVE-MODE-MEMORY-POINTERS:START -->
## recursive-mode memory pointers

- Canonical repository memory lives under `/.recursive/memory/`.
- Read `/.recursive/memory/MEMORY.md` before loading any other memory docs.
- Load only the memory docs relevant to the current task.
- When repository experiential memory may help, load it through the plugin's own TS loader: `recursive_phase` returns the prior-run memory shards relevant to this run and phase (with the reason when none matched), and `/recursive memory "<task>" [--phase <nn>]` prints the same selection with its score components. There is no script to run and no `.recursive/scripts/` step — retrieval is in-process.
- Treat this file as a pointer only; the canonical memory store remains `/.recursive/memory/`.
<!-- RECURSIVE-MODE-MEMORY-POINTERS:END -->
