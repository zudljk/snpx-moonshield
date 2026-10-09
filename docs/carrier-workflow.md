# EDMC → GitHub → Moonshield

The workflow is `.github/workflows/carrier-position.yml`. Its receiver is `scripts/journal-position.mjs`; it uses the same position-observation and itinerary functions as the local CLI. It never calls Inara or Spansh to process a Journal event.

## Activate

1. Commit and push the workflow, receiver, tests, utilities and documentation to the repository's **default branch**. `repository_dispatch` only works when the workflow is present there. Local files alone do not activate it.
2. Ensure Actions are enabled and repository policies permit this workflow's `contents: write` permission. It uses the built-in `GITHUB_TOKEN`, not the EDMC token, to commit. Branch protection must allow these bot commits; the workflow does not bypass branch rules or force-push. If direct bot commits are prohibited, a PR-based integration is required instead.
3. Configure publication as described below.
4. In EDMC, select the same repository, configure the plugin's repository-scoped token and enable delivery. No additional GitHub token secret is required for the workflow.
5. Check Actions → **Carrier position** after a real carrier observation. Inspect the summary, generated commit and the hosting provider's deployment status.

## Processing

The workflow reads JSON from `GITHUB_EVENT_PATH`. Event content is never inserted into shell source. It validates exactly these payload fields: `schemaVersion`, `carrierId`, `eventId`, `observedAt`, `source`, `name`, `systemAddress`. Carrier ID must match `src/data/carrier.json`; addresses must be canonical decimal strings. The timestamp must be canonical UTC and no more than five minutes ahead of the receiver clock. The event ID is checked against the plugin's deterministic SHA-256 calculation (this checks identity consistency, not a cryptographic signature; authorization is supplied by GitHub).

The existing position handler rejects duplicates and older/equal timestamps. Accepted observations persist their Journal timestamp and event ID with the carrier state. Only the carrier and the latest active departure's itinerary can change; completed/cancelled routes, departures and captain's logs are untouched. Ambiguous route movements still update the actual carrier position and record route uncertainty.

For changed data, the workflow installs dependencies with `npm ci`, runs JavaScript and Python tests, builds the site, commits `src/data/carrier.json` and changed itinerary data, and pushes to the default branch. It stores `dist/` as an artifact for seven days. Spansh `id64` values keep their original type. A different event confirming an unchanged location may still commit observation metadata; exact replays do not commit.

## Concurrency and ordering

`concurrency` uses `queue: max` with cancellation disabled. This avoids the default behavior where a newly pending run cancels the previously pending run. GitHub currently permits up to 100 pending runs; excess runs can be canceled. Queue order is based on when runs start waiting, not Journal timestamps, so delayed events can still arrive out of order. Older observations are rejected, protecting the current position; missing intermediate movements may leave route progress uncertain until a later unambiguous movement. This is not a lossless event-stream service.

Every run checks out the latest default-branch tip after leaving the queue, rather than the commit recorded when its event was dispatched. A normal, non-forced push protects concurrent human edits. If someone updates the branch during processing, the push fails: re-run the failed run to check out fresh data and recompute the observation. Do not resolve this by force-pushing generated data.

## Publication

The workflow always commits accepted changes and builds the static site. Publication depends on the existing hosting setup:

- **Hosting provider with Git integration:** let the provider deploy the pushed default branch. Confirm in its dashboard that bot pushes are deployed.
- **Hosting provider with an HTTPS build hook:** add the hook URL as repository Actions secret **`MOONSHIELD_DEPLOY_HOOK`**. The workflow POSTs to this URL after a successful push. It does not follow redirects or expose the secret URL in logs. Choose either automatic Git builds or a hook if both would cause duplicate builds.
- **No hosting integration configured:** the workflow updates the repository and provides the build artifact, but does not publish a website. A missing hook is explicitly noted in the run summary.

A hook returning success means a deployment was requested, not that it finished. Check the hosting provider for completion. A failed hook fails the workflow; re-running it retries the hook even if the observation has already been committed. Manual dry runs never call the hook. No hosting credentials or repository secrets are created by this change.

A commit made using `GITHUB_TOKEN` does **not** start another GitHub Actions `push` workflow. If publication itself uses GitHub Actions, it must be explicitly integrated or dispatched rather than relying on that push trigger. The optional hook is intended for an external hosting provider.

## Preview and recovery

Actions → Carrier position → Run workflow accepts the plugin's `client_payload` object as the **observation** input. Keep **dry_run** checked to validate and preview with no writes, commit or publication. Select the default branch. Uncheck it only for an observation that should actually be processed. A failed dispatch run can also be re-run using GitHub's **Re-run failed jobs** control.

Local preview, using a full event envelope:

```sh
node scripts/journal-position.mjs docs/examples/journal-dispatch.json --dry-run
```

The example comes from the supplied September 27 Journal and is deliberately older than the saved carrier position. It should be reported as stale instead of moving the carrier backwards. For a new preview, use an actual plugin observation; changing identity fields also requires recomputing the event ID.

If a branch-policy, build or transient push failure occurs before the commit is pushed, fix the cause and re-run the original event. If newer observations have since been committed, the earlier event is intentionally ignored; the route's uncertainty rules apply. A workflow canceled due to queue capacity must be re-run manually. The plugin's HTTP 204 confirmation only means GitHub accepted the dispatch, and does not cause automatic retransmission after a workflow failure.

Validation errors fail the run before any data is written. Run details and summaries describe accepted/stale events and publication requests. Full player Journals are not uploaded.

## Validation

```sh
node --test scripts/*.test.mjs
python3 -m unittest discover -s tests/edmc -v
npm run build
```

The receiver tests include Python-to-JavaScript payload compatibility, large IDs, foreign carriers, invalid identities/timestamps, dry runs, replay, out-of-order events, route uncertainty and failed route validation. Deployment tests use a fake HTTP endpoint.

References: [GitHub dispatch triggers](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#repository_dispatch), [concurrency queues](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency), [GITHUB_TOKEN trigger behavior](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).
