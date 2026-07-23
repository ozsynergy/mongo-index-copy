'use strict';

/**
 * Copy and compare MongoDB index definitions without copying application data.
 *
 * Run with:
 *   INDEX_ACTION=plan mongosh --nodb --quiet --file scripts/mongodb-indexes.js
 *   INDEX_ACTION=copy mongosh --nodb --quiet --file scripts/mongodb-indexes.js
 *   INDEX_ACTION=compare mongosh --nodb --quiet --file scripts/mongodb-indexes.js
 */

(() => {
  const action = (process.env.INDEX_ACTION || 'plan').toLowerCase();
  const databaseName = process.env.MONGODB_DATABASE || 'account-fields';
  const sourceUri = process.env.SOURCE_MONGODB_URI;
  const targetUri = process.env.TARGET_MONGODB_URI;
  const validActions = ['compare', 'copy', 'plan'];

  if (!validActions.includes(action)) {
    throw new Error(
      `Invalid INDEX_ACTION "${action}". Expected one of: ${validActions.join(', ')}`,
    );
  }

  if (!sourceUri || !targetUri) {
    throw new Error(
      'SOURCE_MONGODB_URI and TARGET_MONGODB_URI environment variables are required.',
    );
  }

  if (sourceUri === targetUri) {
    throw new Error('Source and target MongoDB URIs must be different.');
  }

  const sourceDb = connect(sourceUri).getSiblingDB(databaseName);
  const targetDb = connect(targetUri).getSiblingDB(databaseName);

  const ignoredIndexFields = new Set([
    'background',
    'buildUUID',
    'ns',
    'ready',
    'v',
  ]);

  function isSystemCollection(collectionName) {
    return collectionName.startsWith('system.');
  }

  function getCollectionNames(database) {
    return database
      .getCollectionNames()
      .filter((collectionName) => !isSystemCollection(collectionName))
      .sort();
  }

  function normalizeValue(value, preserveKeyOrder = false) {
    if (Array.isArray(value)) {
      return value.map((item) => normalizeValue(item));
    }

    if (value === null || typeof value !== 'object') {
      return value;
    }

    const normalized = {};
    const keys = Object.keys(value);
    if (!preserveKeyOrder) {
      keys.sort();
    }

    for (const key of keys) {
      normalized[key] = normalizeValue(value[key]);
    }

    return normalized;
  }

  function normalizeIndex(index) {
    const serialized = EJSON.serialize(index, { relaxed: false });
    const normalized = {};

    for (const field of Object.keys(serialized).sort()) {
      if (ignoredIndexFields.has(field)) {
        continue;
      }

      normalized[field] = normalizeValue(serialized[field], field === 'key');
    }

    return normalized;
  }

  function comparableIndex(index) {
    return JSON.stringify(normalizeIndex(index));
  }

  function indexByName(indexes) {
    return new Map(indexes.map((index) => [index.name, index]));
  }

  function inspectCollection(collectionName) {
    const sourceIndexes = sourceDb.getCollection(collectionName).getIndexes();
    const targetIndexes = targetDb.getCollection(collectionName).getIndexes();
    const sourceByName = indexByName(sourceIndexes);
    const targetByName = indexByName(targetIndexes);
    const missing = [];
    const conflicts = [];
    const targetOnly = [];

    for (const [indexName, sourceIndex] of sourceByName) {
      const targetIndex = targetByName.get(indexName);
      if (!targetIndex) {
        missing.push(sourceIndex);
        continue;
      }

      if (comparableIndex(sourceIndex) !== comparableIndex(targetIndex)) {
        conflicts.push({
          name: indexName,
          source: normalizeIndex(sourceIndex),
          target: normalizeIndex(targetIndex),
        });
      }
    }

    for (const [indexName, targetIndex] of targetByName) {
      if (!sourceByName.has(indexName)) {
        targetOnly.push(targetIndex);
      }
    }

    return { collectionName, conflicts, missing, targetOnly };
  }

  function inspectDatabase() {
    const sourceCollections = getCollectionNames(sourceDb);
    const targetCollections = getCollectionNames(targetDb);
    const sourceCollectionSet = new Set(sourceCollections);
    const targetCollectionSet = new Set(targetCollections);
    const sourceOnlyCollections = sourceCollections.filter(
      (collectionName) => !targetCollectionSet.has(collectionName),
    );
    const targetOnlyCollections = targetCollections.filter(
      (collectionName) => !sourceCollectionSet.has(collectionName),
    );
    const collectionResults = sourceCollections
      .filter((collectionName) => targetCollectionSet.has(collectionName))
      .map(inspectCollection);

    return {
      collectionResults,
      sourceOnlyCollections,
      targetOnlyCollections,
    };
  }

  function hasDifferences(result) {
    return (
      result.sourceOnlyCollections.length > 0 ||
      result.targetOnlyCollections.length > 0 ||
      result.collectionResults.some(
        ({ conflicts, missing, targetOnly }) =>
          conflicts.length > 0 || missing.length > 0 || targetOnly.length > 0,
      )
    );
  }

  function hasUnsafeCopyDifferences(result) {
    return (
      result.targetOnlyCollections.length > 0 ||
      result.collectionResults.some(
        ({ conflicts, targetOnly }) =>
          conflicts.length > 0 || targetOnly.length > 0,
      )
    );
  }

  function printNames(label, values) {
    if (values.length > 0) {
      print(`  ${label}: ${values.join(', ')}`);
    }
  }

  function printReport(result) {
    print(`Database: ${databaseName}`);
    printNames('Source-only collections', result.sourceOnlyCollections);
    printNames('Target-only collections', result.targetOnlyCollections);

    for (const { collectionName, conflicts, missing, targetOnly } of result.collectionResults) {
      if (conflicts.length === 0 && missing.length === 0 && targetOnly.length === 0) {
        continue;
      }

      print(`Collection: ${collectionName}`);
      printNames(
        'Missing on target',
        missing.map((index) => index.name),
      );
      printNames(
        'Target-only indexes',
        targetOnly.map((index) => index.name),
      );

      for (const conflict of conflicts) {
        print(`  Conflicting index: ${conflict.name}`);
        print(`    Source: ${JSON.stringify(conflict.source)}`);
        print(`    Target: ${JSON.stringify(conflict.target)}`);
      }
    }

    if (!hasDifferences(result)) {
      print('Index definitions match exactly.');
    }
  }

  function indexForCreate(index) {
    const copy = {};
    for (const field of Object.keys(index)) {
      if (!ignoredIndexFields.has(field)) {
        copy[field] = index[field];
      }
    }
    return copy;
  }

  print(`Inspecting MongoDB index definitions (action=${action})...`);
  const initialResult = inspectDatabase();
  printReport(initialResult);

  if (action === 'plan') {
    print('Plan complete. No target changes were made.');
    return;
  }

  if (action === 'compare') {
    if (hasDifferences(initialResult)) {
      throw new Error('MongoDB index definitions do not match.');
    }
    return;
  }

  if (hasUnsafeCopyDifferences(initialResult)) {
    throw new Error(
      'Copy aborted. Resolve conflicting indexes, target-only indexes, and target-only collections first. Nothing was changed.',
    );
  }

  let createdCollectionCount = 0;
  for (const collectionName of initialResult.sourceOnlyCollections) {
    print(`Creating empty collection ${collectionName}...`);
    const result = targetDb.runCommand({ create: collectionName });
    if (!result.ok) {
      throw new Error(
        `Failed to create collection ${collectionName}: ${EJSON.stringify(result)}`,
      );
    }
    createdCollectionCount += 1;
  }

  const copyResult = inspectDatabase();
  let createdCount = 0;
  for (const { collectionName, missing } of copyResult.collectionResults) {
    for (const index of missing) {
      if (index.name === '_id_') {
        throw new Error(
          `Copy aborted: ${collectionName} is missing its automatic _id_ index.`,
        );
      }

      print(`Creating ${collectionName}.${index.name}...`);
      const result = targetDb.runCommand({
        createIndexes: collectionName,
        indexes: [indexForCreate(index)],
      });

      if (!result.ok) {
        throw new Error(
          `Failed to create ${collectionName}.${index.name}: ${EJSON.stringify(result)}`,
        );
      }
      createdCount += 1;
    }
  }

  print(
    `Created ${createdCollectionCount} empty collection(s) and ${createdCount} missing index(es). Verifying exact parity...`,
  );
  const finalResult = inspectDatabase();
  printReport(finalResult);
  if (hasDifferences(finalResult)) {
    throw new Error('Index copy completed, but the final comparison failed.');
  }

  print('Index copy and verification completed successfully.');
})();
