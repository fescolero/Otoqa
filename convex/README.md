# Welcome to your Convex functions directory!

Write your Convex functions here.
See https://docs.convex.dev/functions for more.

A query function that takes two arguments looks like:

```ts
// functions.js
import { query } from './_generated/server';
import { v } from 'convex/values';

export const myQueryFunction = query({
  // Validators for arguments.
  args: {
    first: v.number(),
    second: v.string(),
  },

  // Function implementation.
  handler: async (ctx, args) => {
    // Read the database as many times as you need here.
    // See https://docs.convex.dev/database/reading-data.
    const documents = await ctx.db.query('tablename').collect();

    // Arguments passed from the client are properties of the args object.
    console.log(args.first, args.second);

    // Write arbitrary JavaScript here: filter, aggregate, build derived data,
    // remove non-public properties, or create new objects.
    return documents;
  },
});
```

Using this query function in a React component looks like:

```ts
const data = useQuery(api.functions.myQueryFunction, {
  first: 10,
  second: 'hello',
});
```

A mutation function looks like:

```ts
// functions.js
import { mutation } from './_generated/server';
import { v } from 'convex/values';

export const myMutationFunction = mutation({
  // Validators for arguments.
  args: {
    first: v.string(),
    second: v.string(),
  },

  // Function implementation.
  handler: async (ctx, args) => {
    // Insert or modify documents in the database here.
    // Mutations can also read from the database like queries.
    // See https://docs.convex.dev/database/writing-data.
    const message = { body: args.first, author: args.second };
    const id = await ctx.db.insert('messages', message);

    // Optionally, return a value from your mutation.
    return await ctx.db.get(id);
  },
});
```

Using this mutation function in a React component looks like:

```ts
const mutation = useMutation(api.functions.myMutationFunction);
function handleButtonPress() {
  // fire and forget, the most common way to use mutations
  mutation({ first: 'Hello!', second: 'me' });
  // OR
  // use the result once the mutation has completed
  mutation({ first: 'Hello!', second: 'me' }).then((result) => console.log(result));
}
```

Use the Convex CLI to push your functions to a deployment. See everything
the Convex CLI can do by running `npx convex -h` in your project root
directory. To learn more, launch the docs with `npx convex docs`.

## Key Systems

### Load filter facets (HCR, TRIP, custom keys)

Filter values for loads live in three tables, **not** as denormalized columns on
`loadInformation`:

- **`facetDefinitions`** — per-org catalog of facet types. Bootstrapped with
  `HCR` + `TRIP`; per-org custom keys supported for future filter dimensions.
- **`loadTags`** — source of truth. Every `(load, facetKey)` tuple lives here.
  `firstStopDate` denormalized onto each tag row to enable
  `by_org_key_canonical_date` paginated filter queries.
- **`facetValues`** — aggregated dropdown source. Presence-only cache, no
  refcount; orphans pruned nightly by [crons.ts](./crons.ts) →
  `facetMaintenance.pruneOrphanedFacetValues`.

**Single write path**: [lib/loadFacets.ts](./lib/loadFacets.ts) → `setLoadTag`.
Do not patch tag rows or column projections directly. `setLoadTag` handles
canonicalization (trim + uppercase), skips wildcards (`"*"`), and upserts
`facetValues` idempotently.

**Read helpers**: `getLoadFacets(ctx, loadId)` replaces `load.parsedHcr` /
`load.parsedTripNumber` reads. `findLoadIdsByFacets(ctx, {org, hcr, trip})`
replaces `by_hcr_trip` index lookups (which no longer exist).

**FourKites parser**: `fourKitesApiClient.ts:classifyRefToken` is the single
source of truth for "what counts as HCR / TRIP / junk" in a reference-number
token. Used by the parser, the diagnostic scanner, and the cleanup migration.

### Denormalized load fields

Maintained by `loads.ts:syncFirstStopDate`. Any mutation that changes
`loadStops` must call `syncFirstStopDateMutation` to refresh these —
without it, list views show stale origin/destination data.

- `firstStopDate` — enables `by_org_first_stop_date` pagination
- `originCity` / `originState` / `originAddress` — first PICKUP stop
- `destinationCity` / `destinationState` / `destinationAddress` — last DELIVERY stop
- `stopsCountDenorm` — total stop count
- `externalReferenceNumbers` — raw FourKites identifiers.referenceNumbers array
  preserved for future custom-facet extraction

