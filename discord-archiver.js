#!/usr/bin/env node
/*  Discord Archiver – JavaScript (discord.js v14)
 *
 *  What it does:
 *   • On start‑up, loads a checkpoint (last saved message ID).
 *   • Pulls every message newer than that checkpoint (or the whole history)
 *     and writes it to YYYY/MM/DD.md files.
 *   • Afterwards stays online and appends each new message as it arrives.
 *
 *  Configuration – edit the constants below.
 */

import dotenvx from '@dotenvx/dotenvx';
dotenvx.config()

import {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  SnowflakeUtil,
} from "discord.js";
import { promises as fs } from "fs";
import path from "path";

// -------------------- CONFIGURATION --------------------
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;               // keep secret!
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID || process.argv[2];  // from env var or CLI arg
const OUTPUT_ROOT = "./discord_archive";               // where markdown lands
const CHECKPOINT_PATH = "./checkpoint.json";           // tiny JSON file
// ---------------------------------------------------------

if (!DISCORD_TOKEN) {
  console.error("❌ Please set the DISCORD_TOKEN environment variable.");
  process.exit(1);
}

if (!DISCORD_CHANNEL_ID) {
  console.error("❌ Please provide a DISCORD_CHANNEL_ID either via:");
  console.error("   • Environment variable: DISCORD_CHANNEL_ID=your_channel_id");
  console.error("   • Command line argument: node discord-archiver.js your_channel_id");
  process.exit(1);
}

// ------------------------------------------------------------------
// Helper: load / save checkpoint (last processed message ID)
// ------------------------------------------------------------------
async function loadCheckpoint() {
  try {
    const data = await fs.readFile(CHECKPOINT_PATH, "utf8");
    const obj = JSON.parse(data);
    return obj.last_id ?? null;
  } catch {
    return null; // file missing or malformed → start from scratch
  }
}

async function saveCheckpoint(lastId) {
  const payload = JSON.stringify({ last_id: lastId });
  await fs.writeFile(CHECKPOINT_PATH, payload, "utf8");
}

// ------------------------------------------------------------------
// Helper: turn a Discord Message into a Markdown snippet
// ------------------------------------------------------------------
function messageToMarkdown(msg) {
  const ts = msg.createdAt.toISOString().replace("T", " ").replace("Z", " UTC");
  const author = `${msg.author.username}#${msg.author.discriminator} (${msg.author.id})`;

  // Escape backticks so we don’t break fenced code blocks
  const escapedContent = msg.content.replace(/`/g, "`\u200b");

  // Attachments (images, files) – just list URLs
  let attachSection = "";
  if (msg.attachments.size > 0) {
    const lines = [];
    for (const att of msg.attachments.values()) {
      lines.push(`- [${att.name}](${att.url})`);
    }
    attachSection = `\n**Attachments:**\n${lines.join("\n")}`;
  }

  return `### ${author}\n*${ts}*\n\n${escapedContent}${attachSection}`;
}

// ------------------------------------------------------------------
// Write a single message to the appropriate daily file
// ------------------------------------------------------------------
async function writeMessage(msg, channelContext = null) {
  const d = msg.createdAt; // Date object (already in local timezone)
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0"); // months are 0‑based
  const day = String(d.getDate()).padStart(2, "0");

  const dir = path.join(OUTPUT_ROOT, `${year}`, month);
  await fs.mkdir(dir, { recursive: true });

  const filePath = path.join(dir, `${day}.md`);
  const md = messageToMarkdown(msg, channelContext) + "\n\n---\n\n";

  await fs.appendFile(filePath, md, "utf8");
  await saveCheckpoint(msg.id); // persist after successful write
}

// ------------------------------------------------------------------
// Helper: get all threads from a forum channel
// ------------------------------------------------------------------
async function getAllThreads(forumChannel) {
  const threads = [];
  
  // Get active threads
  const activeThreads = await forumChannel.threads.fetchActive();
  threads.push(...activeThreads.threads.values());
  
  // Get archived threads (both public and private)
  const archivedThreads = await forumChannel.threads.fetchArchived();
  threads.push(...archivedThreads.threads.values());
  
  return threads;
}

// ------------------------------------------------------------------
// Bulk export – runs once at startup (or after a restart)
// ------------------------------------------------------------------
async function bulkExport(channel) {
  const checkpoint = await loadCheckpoint();
  console.log(`🔎 Starting bulk export. Checkpoint = ${checkpoint ?? "none"}`);

  if (channel.type === ChannelType.GuildForum) {
    // Handle forum channel - export all threads
    const threads = await getAllThreads(channel);
    console.log(`📚 Found ${threads.length} threads in forum channel`);
    
    for (const thread of threads) {
      console.log(`📝 Exporting thread: ${thread.name}`);
      await exportChannelMessages(thread, checkpoint);
    }
  } else {
    // Handle regular text channel
    await exportChannelMessages(channel, checkpoint);
  }

  console.log("✅ Bulk export completed.");
}

// ------------------------------------------------------------------
// Export messages from a specific channel or thread
// ------------------------------------------------------------------
async function exportChannelMessages(channel, checkpoint) {
  let options = {
    limit: 100, // max per request
    after: checkpoint ? SnowflakeUtil.deconstruct(checkpoint).timestamp : undefined,
  };

  let done = false;
  while (!done) {
    const fetched = await channel.messages.fetch(options);
    if (fetched.size === 0) {
      done = true;
      break;
    }

    // Messages come newest→oldest; reverse to process chronologically
    const msgs = [...fetched.values()].reverse();

    for (const msg of msgs) {
      // Skip bot messages if you don't want them
      if (msg.author.bot) continue;
      await writeMessage(msg, channel);
    }

    // Prepare the next page: the oldest ID we just processed becomes the new "after"
    const oldest = msgs[0];
    options.after = oldest.id;
    // Small pause to stay well under Discord's rate limits
    await new Promise((r) => setTimeout(r, 300));
  }
}

// ------------------------------------------------------------------
// Main – create client, attach listeners, start everything
// ------------------------------------------------------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // privileged intent – enable in dev portal
  ],
  partials: [Partials.Channel], // needed for DM channels (not used here)
});

client.once("ready", async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);

  const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);
  if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildForum)) {
    console.error("❌ Target channel not found or not a text/forum channel.");
    process.exit(1);
  }

  // 1️⃣ Run the one‑time back‑fill (skipping anything already saved)
  await bulkExport(channel);

  // 2️⃣ From now on, `messageCreate` will fire for every new message.
  console.log("👂 Listening for new messages…");
});

client.on("messageCreate", async (msg) => {
  // Guard: ignore messages from bots (including ourselves) unless you want them
  if (msg.author.bot) return;
  
  // Check if message is from our target channel or a thread within our forum channel
  let isFromTargetChannel = false;
  if (msg.channel.id === DISCORD_CHANNEL_ID) {
    // Direct message in the target channel
    isFromTargetChannel = true;
  } else if (msg.channel.isThread && msg.channel.isThread()) {
    // Message in a thread - check if the parent is our target forum channel
    if (msg.channel.parent && msg.channel.parent.id === DISCORD_CHANNEL_ID) {
      isFromTargetChannel = true;
    }
  }
  
  if (!isFromTargetChannel) return;

  await writeMessage(msg, msg.channel);
});

// ------------------------------------------------------------------
// Start the bot
// ------------------------------------------------------------------
client.login(DISCORD_TOKEN).catch((err) => {
  console.error("❌ Failed to login:", err);
  process.exit(1);
});