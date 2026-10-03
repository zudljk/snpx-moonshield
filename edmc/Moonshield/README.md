# Moonshield for EDMarketConnector

Python plugin, version 0.1.0. Uses EDMC's bundled Python, requests/timeout_session, tkinter and sqlite3; no separate Python installation, pip, Git, Node or Moonshield checkout is needed on the gaming PC.

## Install

1. Exit EDMC. Extract `Moonshield-EDMC.zip` into EDMC's plugins directory. On Windows this is `%LOCALAPPDATA%\EDMarketConnector\plugins`. The result must be `plugins\Moonshield\load.py`, not a nested second Moonshield folder.
2. Restart EDMC and open Settings → Moonshield.
3. Keep repository `zudljk/snpx-moonshield` and CarrierID `3706829824`, or configure your own.
4. Set a fine-grained GitHub personal access token restricted to the target repository with **Contents: read and write**. GitHub's repository-dispatch endpoint requires this permission. The token is masked in the dialog but stored in EDMC settings, not encrypted. Alternatively set `MOONSHIELD_GITHUB_TOKEN` in the environment before starting EDMC; it overrides the saved token and is not saved by the plugin.
5. Enable capture and delivery **after installing the receiving GitHub workflow**. Sending is disabled initially. This plugin alone does not update or deploy the site.

The main window shows queue size, delivery errors and the last observation accepted by GitHub during this EDMC session. A successful dispatch means GitHub accepted the event, not that a workflow ran or deployment succeeded. GitHub can accept a dispatch even when no matching workflow exists.

For upgrades, exit EDMC and replace the plugin code files; retain the `state` directory. Its SQLite database is the persistent outbox and duplicate-delivery history. Do not install two copies of the plugin. If the queue is unreadable, the plugin reports an error instead of silently deleting it.

## Events

Only Live-galaxy, non-beta observations for the configured numeric carrier ID are accepted:

- `CarrierLocation` with matching `CarrierID`. Missing `CarrierType` is accepted for older Journals; SquadronCarrier is excluded.
- `Docked` and docked `Location` with `StationType: FleetCarrier` and matching `MarketID`.
- Docked `CarrierJump` with the same explicit identifiers. An on-foot event lacking these identifiers is ignored; `CarrierLocation` is the primary signal.

Player `FSDJump`, `Undocked`, jump requests/cancellations, other carriers and multicrew observations are ignored. No commander name, full Journal, token or other player data is included in the payload. The Journal timestamp is preserved, IDs are decimal strings (Python preserves large integer values exactly), and a deterministic event ID survives replay and retries. Different observations of an unchanged location remain available to the receiver; the route logic must not count these as another jump.

The plugin receives events supplied by EDMC; it does not independently replay every old Journal. Leave EDMC running during play. It cannot observe movement while the game/EDMC is offline.

## Delivery and recovery

Observations are persisted before transmission. A background worker sends pending events in timestamp order, one HTTP request at a time, with connection/read timeouts. Network failures, HTTP errors and rate limits retain the event and retry with exponential backoff (5 seconds up to 5 minutes, or longer if Retry-After requires it). A failing event blocks later events for that repository until delivery succeeds. Correct repository/token settings to recover from authorization errors.

Disabling pauses capture and new delivery attempts; an HTTP request already in flight may finish. Re-enabling resumes persisted events. Repository changes do not redirect old events: each queue item stays bound to its original repository. Switching back resumes that repository's queue. Changing only the carrier filter does not remove previously queued events. Records accepted by GitHub are retained locally to suppress exact replays.

A timeout after GitHub accepted a request can cause a repeated dispatch. The receiver must deduplicate `eventId` and reject stale `observedAt` values. GitHub may run dispatched workflows concurrently or out of order; sequential HTTP requests do not guarantee sequential workflow completion. The receiving workflow needs ordered processing and persistent state, especially for intermediate route movements. Dispatch is not an end-to-end acknowledgement; retry a failed workflow on GitHub.

## Contract for the next GitHub workflow

`POST https://api.github.com/repos/<owner>/<repository>/dispatches`

```json
{
  "event_type": "moonshield-position-v1",
  "client_payload": {
    "schemaVersion": 1,
    "carrierId": "3706829824",
    "eventId": "journal:<sha256>",
    "observedAt": "2026-09-27T20:28:10.000Z",
    "source": "journal",
    "name": "Hegua BP-A c12",
    "systemAddress": "3376347713538"
  }
}
```

The receiver must validate schemaVersion, source, carrierId and the remaining fields, then pass the observation to Moonshield's `applyPositionObservation` and route logic. The stable ID hashes carrier ID, UTC observation time and system address; the Journal event type is deliberately excluded so equivalent same-time location reports share an ID. An address is required; incomplete carrier observations are reported, not guessed.

The workflow, repository changes and deployment are a separate next step and are not included in this plugin.

## Development

From the Moonshield repository:

```sh
python3 -m unittest discover -s tests/edmc -v
python3 scripts/package-edmc.py
```

The ZIP is written to `artifacts/Moonshield-EDMC.zip`. It includes only four explicitly listed distribution files, never runtime queues, tests, example Journals or secrets. Tests run with fake EDMC/HTTP interfaces; actual installation on Windows/EDMC still requires a smoke test.

References: [EDMC plugin API](https://github.com/EDCD/EDMarketConnector/blob/main/PLUGINS.md), [GitHub repository dispatch](https://docs.github.com/en/rest/repos/repos#create-a-repository-dispatch-event).
