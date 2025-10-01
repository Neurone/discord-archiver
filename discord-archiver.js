#!/usr/bin/env node

import dotenvx from '@dotenvx/dotenvx';
dotenvx.config()

import {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
} from "discord.js";
import { promises as fs } from "fs";
import path from "path";

// -------------------- CONFIGURATION --------------------
const CHANNEL_ID = process.env.CHANNEL_ID || process.argv[2];   // from env var or CLI arg
const API_TOKEN = process.env.API_TOKEN;                        // keep secret!
const OUTPUT_ROOT = "./archive";                        // where markdown lands
const CHECKPOINT_PATH = "./archive/checkpoints.json";   // tiny JSON file
const FILTER_TAGS = process.env.FILTER_TAGS ? process.env.FILTER_TAGS.split(',').map(tag => tag.trim().toLowerCase()) : []; // comma-separated tags to filter
// ---------------------------------------------------------

if (!API_TOKEN) {
  console.error("❌ Please set the API_TOKEN environment variable.");
  process.exit(1);
}

if (!CHANNEL_ID) {
  console.error("❌ Please provide a CHANNEL_ID either via:");
  console.error("   • Environment variable: CHANNEL_ID=your_channel_id");
  console.error("   • Command line argument: node discord-archiver.js your_channel_id");
  process.exit(1);
}

// ------------------------------------------------------------------
// Helper: load / save checkpoint per channel/thread
// ------------------------------------------------------------------
async function loadCheckpoints() {
  try {
    const data = await fs.readFile(CHECKPOINT_PATH, "utf8");
    const obj = JSON.parse(data);
    return obj.channels || {};
  } catch {
    return {}; // file missing or malformed → start from scratch
  }
}

async function saveCheckpoint(channelId, lastId) {
  try {
    const checkpoints = await loadCheckpoints();
    checkpoints[channelId] = lastId;
    const payload = JSON.stringify({ channels: checkpoints }, null, 2);
    await fs.writeFile(CHECKPOINT_PATH, payload, "utf8");
  } catch (error) {
    console.error(`❌ Failed to save checkpoint for channel ${channelId}:`, error);
  }
}

function getChannelCheckpoint(checkpoints, channelId) {
  return checkpoints[channelId] || null;
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
// Write a single message without updating checkpoint (for bulk operations)
// ------------------------------------------------------------------
async function writeMessageWithoutCheckpoint(msg, channelContext = null) {
  // Determine the appropriate file based on channel/thread ID
  let channelId;
  let channelName;

  if (channelContext && channelContext.isThread && channelContext.isThread()) {
    // Use thread ID for thread messages
    channelId = channelContext.id;
    channelName = channelContext.name || `Thread ${channelId}`;
  } else {
    // Use main channel ID for direct channel messages  
    channelId = msg.channel.id;
    channelName = msg.channel.name || `Channel ${channelId}`;
  }

  await fs.mkdir(OUTPUT_ROOT, { recursive: true });

  // Create filename with just the numeric channel/thread ID
  const fileName = `${channelId}.md`;
  const filePath = path.join(OUTPUT_ROOT, fileName);

  // Check if message already exists in the file to prevent duplicates
  let fileExists = false;
  let fileContent = "";
  try {
    fileContent = await fs.readFile(filePath, "utf8");
    fileExists = true;

    // Check if this exact message content and timestamp already exists
    const messageTimestamp = msg.createdAt.toISOString().replace("T", " ").replace("Z", " UTC");
    const escapedContent = msg.content.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    if (fileContent.includes(messageTimestamp) && fileContent.includes(msg.content)) {
      // Message already exists, skip writing
      console.log(`⏭️ Skipping duplicate message ID ${msg.id}: ${msg.content.substring(0, 50)}...`);
      return;
    }
  } catch {
    // File doesn't exist, we'll create it with header
  }

  let content = "";
  if (!fileExists) {
    content += `# ${channelName}\n\n`;
  }

  const md = messageToMarkdown(msg, channelContext) + "\n\n---\n\n";
  content += md;

  await fs.appendFile(filePath, content, "utf8");
}

// ------------------------------------------------------------------
// Helper: check if a thread has any of the required tags
// ------------------------------------------------------------------
function hasMatchingTag(thread) {
  if (FILTER_TAGS.length === 0) {
    // No filter tags specified, include all threads
    return true;
  }

  if (!thread.appliedTags || thread.appliedTags.length === 0) {
    // Thread has no tags
    return false;
  }

  // Get the forum channel to access tag names
  const forumChannel = thread.parent;
  if (!forumChannel || !forumChannel.availableTags) {
    return false;
  }

  // Convert thread tag IDs to tag names
  const threadTagNames = thread.appliedTags
    .map(tagId => {
      const tag = forumChannel.availableTags.find(availableTag => availableTag.id === tagId);
      return tag ? tag.name.toLowerCase() : null;
    })
    .filter(name => name !== null);

  // Check if any thread tag matches any filter tag (case insensitive)
  return threadTagNames.some(tagName =>
    FILTER_TAGS.some(filterTag => tagName.includes(filterTag) || filterTag.includes(tagName))
  );
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

  // Filter threads by tags if specified
  const filteredThreads = threads.filter(thread => hasMatchingTag(thread));

  if (FILTER_TAGS.length > 0) {
    console.log(`🏷️ Filtering by tags: ${FILTER_TAGS.join(', ')}`);
    console.log(`📊 Found ${filteredThreads.length}/${threads.length} threads matching filter criteria`);
  }

  return filteredThreads;
}

// ------------------------------------------------------------------
// Bulk export – runs once at startup (or after a restart)
// ------------------------------------------------------------------
async function bulkExport(channel) {
  const checkpoints = await loadCheckpoints();
  console.log(`🔎 Starting bulk export with ${Object.keys(checkpoints).length} existing checkpoints`);

  if (channel.type === ChannelType.GuildForum) {
    // Handle forum channel - export all threads
    const threads = await getAllThreads(channel);
    console.log(`📚 Found ${threads.length} threads in forum channel`);

    for (const thread of threads) {
      const threadCheckpoint = getChannelCheckpoint(checkpoints, thread.id);
      console.log(`📝 Exporting thread: ${thread.name} (checkpoint: ${threadCheckpoint ?? "none"})`);
      await exportChannelMessages(thread, threadCheckpoint);
    }
  } else {
    // Handle regular text channel
    const channelCheckpoint = getChannelCheckpoint(checkpoints, channel.id);
    console.log(`📝 Exporting channel: ${channel.name || channel.id} (checkpoint: ${channelCheckpoint ?? "none"})`);
    await exportChannelMessages(channel, channelCheckpoint);
  }

  console.log("✅ Bulk export completed.");
}

// ------------------------------------------------------------------
// Export messages from a specific channel or thread
// ------------------------------------------------------------------
async function exportChannelMessages(channel, checkpoint) {
  // If we have a checkpoint, only fetch messages newer than it
  let options = {
    limit: 100, // max per request
  };

  // Only add 'after' if we have a checkpoint - this fetches messages AFTER the checkpoint
  if (checkpoint) {
    options.after = checkpoint;
    console.log(`📍 Using checkpoint ${checkpoint} for channel ${channel.id}`);
  }

  let processedCount = 0;
  let latestMessageId = checkpoint; // Track the latest message ID for checkpoint updating
  let done = false;

  while (!done) {
    const fetched = await channel.messages.fetch(options);
    if (fetched.size === 0) {
      done = true;
      break;
    }

    // Messages come newest→oldest; reverse to process chronologically
    const msgs = [...fetched.values()].reverse();
    let batchProcessedCount = 0;

    for (const msg of msgs) {
      // Skip bot messages if you don't want them
      if (msg.author.bot) continue;

      // Skip if message is older than or equal to checkpoint (safety check)
      if (checkpoint && msg.id <= checkpoint) {
        continue;
      }

      console.log(`🔄 Processing message ${msg.id}`);

      // Write message without updating checkpoint yet
      await writeMessageWithoutCheckpoint(msg, channel);

      // Track the latest message ID
      if (!latestMessageId || msg.id > latestMessageId) {
        latestMessageId = msg.id;
      }

      processedCount++;
      batchProcessedCount++;
    }

    // Only update checkpoint after processing the entire batch
    if (batchProcessedCount > 0 && latestMessageId) {
      await saveCheckpoint(channel.id, latestMessageId);
    }

    // Stop fetching - we got all messages in this batch
    // Since we're using 'after', we only get messages newer than checkpoint
    done = true;
  }

  if (processedCount === 0 && checkpoint) {
    console.log(`✅ No new messages found for channel ${channel.id}`);
  } else {
    console.log(`✅ Processed ${processedCount} new messages for channel ${channel.id}`);
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

  const channel = await client.channels.fetch(CHANNEL_ID);
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
  if (msg.channel.id === CHANNEL_ID) {
    // Direct message in the target channel
    isFromTargetChannel = true;
  } else if (msg.channel.isThread && msg.channel.isThread()) {
    // Message in a thread - check if the parent is our target forum channel
    if (msg.channel.parent && msg.channel.parent.id === CHANNEL_ID) {
      // Also check if the thread has matching tags
      if (hasMatchingTag(msg.channel)) {
        isFromTargetChannel = true;
      }
    }
  }

  if (!isFromTargetChannel) return;

  // Check if this is a new thread or if we need to catch up on missed messages
  const checkpoints = await loadCheckpoints();
  const checkpoint = checkpoints[msg.channel.id];

  if (!checkpoint) {
    // This is a new thread - fetch all historical messages first
    console.log(`📥 New thread detected: ${msg.channel.name || msg.channel.id} - fetching historical messages...`);
    await exportChannelMessages(msg.channel);
    return; // exportChannelMessages already saved the checkpoint
  }

  // Check if there are missed messages (e.g., tag was removed and re-added)
  if (msg.id > checkpoint) {
    // Fetch all messages since the last checkpoint to catch any missed ones
    console.log(`🔄 Catching up on missed messages for: ${msg.channel.name || msg.channel.id}`);
    await exportChannelMessages(msg.channel, checkpoint);
    return; // exportChannelMessages already saved the checkpoint
  }

  // For real-time messages that are already up to date, write and update checkpoint immediately
  await writeMessageWithoutCheckpoint(msg, msg.channel);
  await saveCheckpoint(msg.channel.id, msg.id);
});

// ------------------------------------------------------------------
// Start the bot
// ------------------------------------------------------------------
client.login(API_TOKEN).catch((err) => {
  console.error("❌ Failed to login:", err);
  process.exit(1);
});