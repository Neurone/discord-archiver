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
const API_TOKEN = process.env.API_TOKEN;                                              // keep secret!
const CHANNEL_ID = process.env.CHANNEL_ID || process.argv[2];                         // from env var or CLI arg
const MAX_FETCH_SIZE = process.env.MAX_FETCH_SIZE || 100;                             // max allowed by Discord API
const OUTPUT_ROOT = process.env.OUTPUT_ROOT || "./archive";                           // where markdown lands
const CHECKPOINT_PATH = process.env.CHECKPOINT_PATH || "./archive/checkpoints.json";  // tiny JSON file
const FILTER_TAGS = process.env.FILTER_TAGS ? process.env.FILTER_TAGS.split(',').map(tag => tag.trim().toLowerCase()) : []; // comma-separated tags to filter
// ---------------------------------------------------------

if (!API_TOKEN) {
  console.error("❌ Please set the API_TOKEN environment variable.");
  process.exit(1);
}

if (!CHANNEL_ID) {
  console.error("❌ Please provide a CHANNEL_ID either via:");
  console.error("   • Environment variable: CHANNEL_ID=your_channel_id");
  console.error("   • Command line argument: node discord-archiver.js <your_channel_id>");
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
    console.warn("⚠️  checkpoint missing or malformed → starting from scratch:");
    return {};
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
// Helper: Check if a referenced message is deleted
// ------------------------------------------------------------------
async function isMessageDeleted(client, channelId, messageId) {
  try {
    const channel = await client.channels.fetch(channelId);
    if (channel) {
      await channel.messages.fetch(messageId);
      return false; // Message exists
    }
  } catch (error) {
    // Message doesn't exist or can't be fetched
  }
  return true; // Treat as deleted
}

// ------------------------------------------------------------------
// Helper: Format reply reference with deletion check
// ------------------------------------------------------------------
async function formatReplyReference(msg) {
  if (!msg.reference || !msg.reference.messageId) {
    return "";
  }

  const refId = msg.reference.messageId;
  const isDeleted = await isMessageDeleted(msg.client, msg.reference.channelId, refId);
  
  if (isDeleted) {
    return `\nin reply to **DELETED MESSAGE** (${refId})`;
  } else {
    return `\nin reply to [${refId}](#${refId})`;
  }
}

// ------------------------------------------------------------------
// Helper: Format message content as markdown
// ------------------------------------------------------------------
function formatMessageMarkdown(msg, reference = "") {
  const author = `${msg.author.username}#${msg.author.discriminator} (${msg.author.id})`;
  const timestamp = msg.createdAt.toISOString().replace("T", " ").replace("Z", " UTC");
  
  // Check if message was edited
  let modifiedMarker = "";
  if (msg.editedAt) {
    const editedTimestamp = msg.editedAt.toISOString().replace("T", " ").replace("Z", " UTC");
    modifiedMarker = `\n**MODIFIED** last time at *${editedTimestamp}*`;
  }
  
  const escapedContent = msg.content.replace(/`/g, "`\u200b");

  // Attachments
  let attachmentSection = "";
  if (msg.attachments.size > 0) {
    const lines = [];
    for (const att of msg.attachments.values()) {
      lines.push(`- [${att.name}](${att.url})`);
    }
    attachmentSection = `\n**Attachments:**\n${lines.join("\n")}`;
  }

  return `### Message ${msg.id}\nby ${author}\nat *${timestamp}*${modifiedMarker}${reference}\n\n${escapedContent}\n${attachmentSection}\n---\n\n`;
}

// ------------------------------------------------------------------
// Helper: Check if message is in target channel/thread
// ------------------------------------------------------------------
function isTargetMessage(msg) {
  const isTargetChannel = msg.channel.id === CHANNEL_ID;
  const isThread = msg.channel.isThread && msg.channel.isThread();
  const isTargetThread = isThread && 
    msg.channel.parent?.id === CHANNEL_ID && 
    hasMatchingTag(msg.channel);
  
  return isTargetChannel || isTargetThread;
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

  // Create filename with just the numeric channelID (allow only safe chars to prevent path traversal)
  const safeChannelId = String(channelId).replace(/[^a-zA-Z0-9_-]/g, '');
  const fileName = `${safeChannelId}.md`;
  const filePath = path.join(OUTPUT_ROOT, fileName);

  // Check if message already exists in the file to prevent duplicates
  let fileExists = false;
  let fileContent = "";
  try {
    fileContent = await fs.readFile(filePath, "utf8");
    fileExists = true;

    // Check if this exact message already exists
    const messageHeader = "### Message " + msg.id;

    if (fileContent.includes(messageHeader)) {
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

  const reference = await formatReplyReference(msg);
  const md = formatMessageMarkdown(msg, reference);
  content += md;

  await fs.appendFile(filePath, content, "utf8");
}

// ------------------------------------------------------------------
// Helper: Delete a message from the markdown file and update references
// ------------------------------------------------------------------
async function deleteMessageFromFile(channelId, messageId) {
  // Create filename with just the numeric channelID (allow only safe chars to prevent path traversal)
  const safeChannelId = String(channelId).replace(/[^a-zA-Z0-9_-]/g, '');
  const fileName = `${safeChannelId}.md`;
  const filePath = path.join(OUTPUT_ROOT, fileName);

  try {
    let content = await fs.readFile(filePath, "utf8");
    
    // Find and remove the message section completely
    const messageRegex = new RegExp(`### Message ${messageId}\\n[\\s\\S]*?\\n---\\n\\n`, 'g');
    
    const match = content.match(messageRegex);
    if (match) {
      // Remove the message
      content = content.replace(messageRegex, '');
      
      // Update all references to this deleted message
      // Find all reply references to this message and mark them as deleted
      const replyRegex = new RegExp(`(in reply to \\[${messageId}\\]\\(#${messageId}\\))`, 'g');
      content = content.replace(replyRegex, `in reply to **DELETED MESSAGE** (${messageId})`);
      
      await fs.writeFile(filePath, content, "utf8");
      console.log(`🗑️  Removed message ${messageId} and updated references in file`);
      return true;
    } else {
      console.log(`⚠️  Message ${messageId} not found in file`);
      return false;
    }
  } catch (error) {
    console.error(`❌ Failed to delete message ${messageId}:`, error);
    return false;
  }
}

// ------------------------------------------------------------------
// Helper: Update a message in the markdown file (keep old version with marker)
// ------------------------------------------------------------------
async function updateMessageInFile(msg, channelContext = null) {
  const channelId = channelContext ? channelContext.id : msg.channel.id;
  const messageId = msg.id;
  // Create filename with just the numeric channelID (allow only safe chars to prevent path traversal)
  const safeChannelId = String(channelId).replace(/[^a-zA-Z0-9_-]/g, '');
  const fileName = `${safeChannelId}.md`;
  const filePath = path.join(OUTPUT_ROOT, fileName);
  
  try {
    const content = await fs.readFile(filePath, "utf8");
    
    // Find the message section
    const messageRegex = new RegExp(`(### Message ${messageId}\\n)([\\s\\S]*?)(\\n---\\n)`, 'm');
    const match = content.match(messageRegex);
    
    if (match) {
      // Force editedAt to current time for modification marker
      if (!msg.editedAt) {
        msg.editedAt = new Date();
      }
      
      const reference = await formatReplyReference(msg);
      const newContent = formatMessageMarkdown(msg, reference);
      
      const updatedContent = content.replace(messageRegex, newContent);
      await fs.writeFile(filePath, updatedContent, "utf8");
      console.log(`✏️  Updated message ${messageId} in local file`);
      return true;
    } else {
      // Message wasn't in file, just add it
      console.log(`➕ Adding message ${messageId} to local file`);
      await writeMessageWithoutCheckpoint(msg, channelContext);
      return false;
    }
  } catch (error) {
    console.error(`❌ Failed to update message ${messageId}:`, error);
    return false;
  }
}

// ------------------------------------------------------------------
// Helper: check if a thread has any of the required tagsf
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
  const channel = thread.parent;
  if (!channel || !channel.availableTags) {
    return false;
  }

  // Convert thread tag IDs to tag names
  const threadTagNames = thread.appliedTags
    .map(tagId => {
      const tag = channel.availableTags.find(availableTag => availableTag.id === tagId);
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
async function getAllThreads(channel) {
  const threads = [];

  // Get active threads
  const activeThreads = await channel.threads.fetchActive();
  threads.push(...activeThreads.threads.values());

  // Get archived threads (both public and private)
  const archivedThreads = await channel.threads.fetchArchived();
  threads.push(...archivedThreads.threads.values());

  // Filter threads by tags if specified
  const filteredThreads = threads.filter(thread => hasMatchingTag(thread));

  console.log(`📚 Found ${threads.length} threads in channel "${channel.name || channel.id}"`);

  if (FILTER_TAGS.length > 0) {
    console.log(`🏷️  Filtering by tags: ${FILTER_TAGS.join(', ')}`);
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
    // Handle forum channel - export all threads matching filter
    for (const thread of await getAllThreads(channel)) {
      const threadCheckpoint = getChannelCheckpoint(checkpoints, thread.id);
      console.log(`📝 Exporting thread "${thread.name}" (checkpoint: ${threadCheckpoint ?? "none"})`);
      await exportChannelMessages(thread, threadCheckpoint);
    }
  } else {
    // Handle regular text channel
    const channelCheckpoint = getChannelCheckpoint(checkpoints, channel.id);
    console.log(`📝 Exporting channel "${channel.name || channel.id}" (checkpoint: ${channelCheckpoint ?? "none"})`);
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
    limit: MAX_FETCH_SIZE,
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
  partials: [
    Partials.Channel,
    Partials.Message, // Required for messageUpdate events on uncached messages
  ],
});

client.once("clientReady", async () => {
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
  // Only process messages from the target channel or matching threads
  if (!isTargetMessage(msg)) return;

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

client.on("messageUpdate", async (oldMsg, msg) => {
  // Partial messages need to be fetched
  if (msg.partial) {
    try {
      await msg.fetch();
    } catch (error) {
      console.error('❌ Failed to fetch partial message:', error);
      return;
    }
  }

  // Only process messages from the target channel or matching threads
  if (!isTargetMessage(msg)) return;

  console.log(`🌍 Message ${msg.id} updated in Discord channel "${msg.channel.name || msg.channel.id}"`);
  await updateMessageInFile(msg, msg.channel);
});

client.on("messageDelete", async (msg) => {
  // Only process messages from the target channel or matching threads
  if (!isTargetMessage(msg)) return;

  console.log(`🌍 Message ${msg.id} deleted in Discord channel "${msg.channel.name || msg.channel.id}"`);
  await deleteMessageFromFile(msg.channel.id, msg.id);
});

// ------------------------------------------------------------------
// Start the process
// ------------------------------------------------------------------
client.login(API_TOKEN).catch((err) => {
  console.error("❌ Failed to login:", err);
  process.exit(1);
});