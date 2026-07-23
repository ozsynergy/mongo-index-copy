# MongoDB index copy and comparison

`mongodb-indexes.js` compares index definitions between two MongoDB-compatible databases and can create indexes that are missing from the target. It does not insert, update, delete, or copy application documents.

Run it after dsync has created the target collections and entered change-data-capture mode, but before the final write freeze and connection-string cutover.

## Requirements

- `mongosh` is installed.
- The source credentials can list collections and indexes.
- The target credentials can list collections and indexes and run `createIndexes`.
- Both endpoints can be reached from the machine running the script.

Put connection strings in environment variables so they are not passed in command-line arguments:

```bash
export SOURCE_MONGODB_URI='mongodb://...'
export TARGET_MONGODB_URI='mongodb://...'
export MONGODB_DATABASE='db-name'
```

## 1. Preview the copy

Plan mode is the default and makes no target changes:

```bash
INDEX_ACTION=plan mongosh --nodb --quiet --file scripts/mongodb-indexes.js
```

It reports:

- indexes missing from the target;
- same-name indexes whose definitions differ;
- indexes that exist only on the target; and
- collections that exist on only one endpoint.

## 2. Create missing indexes

```bash
INDEX_ACTION=copy mongosh --nodb --quiet --file scripts/mongodb-indexes.js
```

Copy mode performs a full preflight before writing. It creates empty target collections for source-only collections, creates missing indexes, and then runs an exact comparison. It does not drop or replace anything and does not copy documents.

The copy is aborted before any changes if it finds:

- a target-only collection;
- a same-name index with a different definition; or
- a target-only index.

This conservative behavior prevents the script from guessing whether a target object is safe to remove. Resolve those differences manually, rerun plan mode, and only then run the copy.

## 3. Compare after migration

```bash
INDEX_ACTION=compare mongosh --nodb --quiet --file scripts/mongodb-indexes.js
```

Compare mode is read-only and exits non-zero if any collection or normalized index definition differs. It ignores server-generated index metadata (`v`, `ns`, `background`, `buildUUID`, and `ready`) while comparing functional index settings. Compound index key order is preserved because it affects index behavior.

## Operational notes

- The automatic `_id_` index is compared but never explicitly created.
- A source-only collection is created empty with default collection options. The script copies indexes, not collection validators or other collection-level options.
- Index names and options are preserved, including unique, sparse, TTL, partial, collation, wildcard, text, and geospatial settings.
- Creating a unique index will fail if the target contains duplicate values. The script leaves it unique and stops so the duplicate data can be investigated.
- Building indexes causes MongoDB to scan existing target documents and consumes database resources even though this script does not copy or modify those documents. Monitor the target and schedule large index builds appropriately.
- The script never prints either connection string.


