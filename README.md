# Discord Archiver

Archive Discord channel messages locally. Automatically downloads message history and monitors for new messages in real-time.

## Quickstart

```sh
git clone https://github.com/neurone/discord-archiver.git
cd discord-archiver
npm install
npx dotenvx set API_TOKEN "<YOUR_DISCORD_BOT_TOKEN>"
npm start <CHANNEL_ID>
```

Archives are saved as Markdown files in the `archive/` directory.

## Features

- Incremental archiving with per-channel/thread checkpoints (no re-downloading history each run)
- Supports regular text channels and forum channels (including archived threads)
- Optional thread filtering by forum tags via `FILTER_TAGS`
- Real-time capture of new messages after initial backfill
- Message edits reflected in place with a `MODIFIED` marker and latest edit timestamp
- Message deletions remove the original block and automatically update any replies to show `DELETED MESSAGE (id)`
- Preserves reply context; replies to already-deleted messages are marked during both bulk export and live mode
- Attachment links preserved (filename + direct URL)
- Safe filename handling (sanitized channel/thread IDs)
- Stateless operation besides a lightweight JSON checkpoints file

## Environment Variables

Set via `npx dotenvx set <NAME> <VALUE>` or your preferred method.

| Variable | Required | Description |
|----------|----------|-------------|
| `API_TOKEN` | Yes | Discord bot token (with Message Content intent enabled) |
| `CHANNEL_ID` | Yes (unless passed as CLI arg) | ID of the channel (text or forum) to archive |
| `FILTER_TAGS` | No | Comma-separated list of forum tag names to include (case-insensitive, substring match) |
| `MAX_FETCH_SIZE` | No | Batch size for each fetch (default 100, Discord max) |
| `OUTPUT_ROOT` | No | Output directory for markdown (default `./archive`) |
| `CHECKPOINT_PATH` | No | Path to checkpoints JSON (default `./archive/checkpoints.json`) |

CLI argument `<CHANNEL_ID>` overrides absence of `CHANNEL_ID` in env.

## Output Format

Each channel or thread is archived to `archive/<CHANNEL_OR_THREAD_ID>.md`.

Message structure example:

```markdown
### Message 1234567890123456789
by alice#0 (111111111111111111)
at *2025-01-01 10:00:00.000 UTC*
**MODIFIED** last time at *2025-01-01 10:05:30.000 UTC*
in reply to **DELETED MESSAGE** (1234567890123000000)

This is the message body (supports markdown as-is)

**Attachments:**
- [image.png](https://cdn.discordapp.com/attachments/…/image.png)
---
```

Notes:
- `**MODIFIED**` line appears only if the message has been edited.
- Reply line appears only for replies; if the parent was deleted, it is annotated as `DELETED MESSAGE`.
- Deleted messages are fully removed; their former replies update automatically.

## Real-Time Behavior

1. On startup: performs a backfill (only messages newer than the last checkpoint if it exists).
2. While running: listens for `messageCreate`, `messageUpdate`, `messageDelete`, and `threadUpdate`.
3. Edits: in-place rewrite with updated edit timestamp; no historical versions retained.
4. Deletes: message block removed; any existing references rewritten to a deleted marker.
5. Replies to already-deleted parents (even if deleted before startup) are detected and marked.

## Forum Thread Filtering

When archiving a forum channel, all threads (active + archived) are enumerated. If `FILTER_TAGS` is set:

- Each applied tag name on a thread is lowercased.
- A thread is included if ANY tag name contains (or is contained by) ANY filter token.
- Example: `FILTER_TAGS="bug,feature"` will match `bug`, `bug report`, `feature-request`, etc.

Unset `FILTER_TAGS` to archive every thread.

## Checkpoints & Incremental Sync

The file at `CHECKPOINT_PATH` stores the last processed message ID per channel/thread:

```json
{
	"channels": {
		"1423048371555405876": "1423073354352562186"
	}
}
```

During startup:
- If a checkpoint exists: only messages with IDs greater than the stored ID are fetched (using Discord's `after` option).
- If missing/corrupt: a full backfill is performed.

During runtime:
- New messages are appended immediately and checkpoint updated.
- If a tag reconfiguration or missed gap occurs, the logic re-fetches only the missing span.

## Safety & Operational Notes

- Filenames are sanitized to alphanumerics / underscore / hyphen.
- Only minimal state is persisted (checkpoint JSON); archives are append-only except for edit/delete rewrites.
- The script requires the **Message Content Intent**; ensure it's enabled in the Developer Portal.
- Large channels: uses a single fetch window per run (checkpoint-based) instead of walking history backwards.
- Rate limits: relies on discord.js internal backoff; no manual throttling required at current scope.

## Limitations / Future Ideas

- No pagination backwards beyond the first startup snapshot when no checkpoint exists (could add full historical crawl).
- No preservation of previous edit revisions (could add versioned collapsible blocks).
- No rich embed capture; only message `content` and attachment URLs.
- Does not currently export reactions or pin status.

## Cleaning Archives

## Configuration Options

### Optional: Filter Forum Threads by Tags

When archiving forum channels, you can filter specific threads by tags:

```sh
npx dotenvx set FILTER_TAGS "bug,feature-request"
```

Multiple tags can be comma-separated. Only threads with matching tags will be archived. Leave unset to archive all threads.

### Optional: Set Channel ID via Environment

Instead of passing the channel ID as an argument, you can set it as an environment variable:

```sh
npx dotenvx set CHANNEL_ID "<YOUR_CHANNEL_ID>"
npx dotenvx run -- node discord-archiver.js
```

## Setup Details

### Get Your Discord Bot Token

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application
3. Navigate to the "Bot" section and create a bot
4. Copy the bot token and use it as `API_TOKEN`
5. Enable **Message Content Intent** in the bot settings
6. Invite the bot to your server with "Read Messages" and "Read Message History" permissions

### Get the Channel ID

Enable Developer Mode in Discord (Settings → Advanced → Developer Mode), then right-click any channel and select "Copy Channel ID".

## Usage

Run the archiver for a specific channel:
```sh
npx dotenvx run -- node discord-archiver.js <CHANNEL_ID>
```

The archiver will:
- Download all existing messages from the channel
- Save them as a Markdown file in `archive/`
- Continue listening for new messages
- Update the archive in real-time

## Cleaning Archives

Remove all archived data:
```sh
npm run clean
```

This removes all markdown files and the checkpoint JSON—subsequent runs will re-backfill from scratch.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Script exits immediately | Missing `API_TOKEN` or `CHANNEL_ID` | Set env vars or pass channel ID CLI arg |
| No edits detected | Missing `Partials.Message` or permissions | Ensure current code & bot has Message Content intent |
| Replies show raw IDs only | Parent message not yet archived | Will update when parent appears (if still exists) |
| Deleted parent not marked | Cache race | Restart; ensure deletion happened after bot startup |

Enable verbose logging by temporarily adding custom `console.log` lines where needed.

## License

MIT License. See `LICENSE` file.

