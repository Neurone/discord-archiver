# discord-archiver
Download all conversations from a Discord channel and listen for new messages to create a local archive that you can refer to later.

## Quickstart

```sh
git clone https://github.com/neurone/discord-archiver.git
cd discord-archiver
npm i
npx dotenvx set DISCORD_TOKEN "<INSERT_YOUR_TOKEN_HERE>"
npx dotenvx run -- node discord-archiver <INSERT_YOUR_CHANNEL_ID_HERE>
```

