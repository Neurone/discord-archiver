# Discord Archiver

Archive Discord channel messages locally. Automatically downloads message history and monitors for new messages in real-time.

## Quickstart

```sh
git clone https://github.com/neurone/discord-archiver.git
cd discord-archiver
npm install
npx dotenvx set API_TOKEN "<YOUR_DISCORD_BOT_TOKEN>"
npx dotenvx run -- node discord-archiver.js <CHANNEL_ID>
```

Archives are saved as Markdown files in the `archive/` directory.

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

