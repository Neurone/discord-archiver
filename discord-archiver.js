#!/usr/bin/env node
import dotenvx from '@dotenvx/dotenvx';
dotenvx.config()

import { Client, GatewayIntentBits, Partials, ChannelType } from "discord.js";
import { promises as fs } from "fs";
import path from "path";

// -------------------- CONFIGURATION --------------------
const API_TOKEN = process.env.API_TOKEN; // keep secret!
const CHANNEL_IDS_INPUT = process.argv[2] || process.env.CHANNEL_IDS; // from CLI arg or env var
const CHANNEL_IDS = CHANNEL_IDS_INPUT
  ? CHANNEL_IDS_INPUT.split(',').map(id => id.trim()).filter(Boolean)
  : [];
const MAX_FETCH_SIZE = Number(process.env.MAX_FETCH_SIZE) || 100; // max allowed by Discord API
const OUTPUT_ROOT = process.env.OUTPUT_ROOT || "./data/archive"; // where markdown lands
const CHECKPOINT_PATH = process.env.CHECKPOINT_PATH || "./data/checkpoints.json"; // tiny JSON file
const FILTER_TAGS = (process.env.FILTER_TAGS || '')
  .split(',')
  .map(t => t.trim().toLowerCase())
  .filter(Boolean);
// ---------------------------------------------------------

if (!API_TOKEN) {
  console.error("❌ Please set the API_TOKEN environment variable.");
  process.exit(1);
}

if (!CHANNEL_IDS.length) {
  console.error("❌ Please provide channel IDs either via:");
  console.error("   • Command line argument: node discord-archiver.js <channel_id1,channel_id2,...>");
  console.error("   • Environment variable: CHANNEL_IDS=channel_id1,channel_id2,...");
  process.exit(1);
}

// -------------------- Small utilities ----------------------------
const safeId = v => String(v).replace(/[^a-zA-Z0-9_-]/g, '');
const getArchiveFilePath = channelId => path.join(OUTPUT_ROOT, `${safeId(channelId)}.md`);
const ensureArchiveDir = () => fs.mkdir(OUTPUT_ROOT, { recursive: true });
const formatTimestamp = d => d.toISOString().replace('T', ' ').replace('Z', ' UTC');
const readFileIfExists = async file => { try { return await fs.readFile(file, 'utf8'); } catch { return null; } };

// ------------------------------------------------------------------
// Load / save checkpoint per channel/thread
// ------------------------------------------------------------------
const readJSON = async file => {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; }
};
const writeJSON = (file, content) => fs.writeFile(file, JSON.stringify(content, null, 2), 'utf8');
const loadCheckpoints = async () => (await readJSON(CHECKPOINT_PATH))?.channels || {};
const saveCheckpoint = async (channelId, lastId) => {
  try {
    const checkpoints = await loadCheckpoints();
    if (checkpoints[channelId] && checkpoints[channelId] >= lastId) return; // already newer or equal
    checkpoints[channelId] = lastId;
    await writeJSON(CHECKPOINT_PATH, { channels: checkpoints });
  } catch (e) { console.error(`❌ Failed to save checkpoint for ${channelId}:`, e); }
};
const getChannelCheckpoint = (checkpoints, id) => checkpoints[id] || null;

// ------------------------------------------------------------------
// CENTRALIZED MESSAGE FORMAT CONFIGURATION
// Define the message structure here. All patterns and operations
// are automatically derived from this configuration.
// ------------------------------------------------------------------
const MessageFormat = {
  // The main section delimiter - change this to change how messages are separated
  sectionMarker: (msgId) => `## Message ${msgId}`,

  // Message metadata format
  metadata: {
    author: (displayName, username, discriminator, userId) => `By @${displayName} (${username}#${discriminator} ${userId})`,
    timestamp: (ts) => `at *${ts}*`,
    modified: (ts) => `**MODIFIED** last time at *${ts}*`,
  },

  // How to identify a reply reference link
  replyLinkFormat: {
    prefix: 'in reply to ',
    linkText: (msgId) => msgId,
    linkHref: (msgId) => `#message-${msgId}`,
  },

  // How to show a deleted message reference
  deletedReplyFormat: (msgId) => `**DELETED MESSAGE** (${msgId})`,

  // Attachments format
  attachments: {
    header: '**Attachments:**',
    item: (name, url) => `- [${name}](${url})`,
  },

  // Code block wrapper for message content (prevents markdown injection)
  codeBlock: {
    language: 'txt', // Language identifier for the code block
    // Sanitize content to prevent breaking out of code blocks
    sanitize: (content) => {
      if (!content) return '';
      // Find the longest sequence of backticks in the content
      const backtickMatches = content.match(/`+/g) || [];
      const maxBackticks = backtickMatches.reduce((max, match) => Math.max(max, match.length), 2);
      // Use one more backtick than the longest sequence found (minimum 3)
      const fenceLength = Math.max(3, maxBackticks + 1);
      const fence = '`'.repeat(fenceLength);
      return { fence, content };
    },
  },
};

// ------------------------------------------------------------------
// AUTO-GENERATED PATTERNS FROM FORMAT CONFIGURATION
// These are automatically generated from MessageFormat above.
// DO NOT MODIFY THESE DIRECTLY - change MessageFormat instead.
// ------------------------------------------------------------------
const MessagePatterns = {
  // Get the section marker string
  sectionMarker: (msgId) => MessageFormat.sectionMarker(msgId),

  // Escape special regex characters in a string
  escapeRegex: (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),

  // Generate regex to match a complete message block
  messageBlockRegex: (msgId) => {
    const marker = MessageFormat.sectionMarker(msgId);
    const escapedMarker = MessagePatterns.escapeRegex(marker);
    // Extract just the prefix part (e.g., "## Message ") for the lookahead
    const markerPrefix = MessageFormat.sectionMarker('').replace(/\s*$/, ''); // Remove trailing space if ID was empty
    const escapedPrefix = MessagePatterns.escapeRegex(markerPrefix);
    // Match: (start or newline)(exact marker + newline + content until next marker or end)
    return new RegExp(
      `(^|\\n)(${escapedMarker}\\n(?:(?!\\n${escapedPrefix} ).)*?)(?=\\n${escapedPrefix} |$)`,
      'gs'
    );
  },

  // Generate regex to find reply references
  replyReferenceRegex: (msgId) => {
    const { prefix, linkText, linkHref } = MessageFormat.replyLinkFormat;
    const text = linkText(msgId);
    const href = linkHref(msgId);
    const escapedPrefix = MessagePatterns.escapeRegex(prefix);
    const escapedText = MessagePatterns.escapeRegex(text);
    const escapedHref = MessagePatterns.escapeRegex(href);
    return new RegExp(`${escapedPrefix}\\[${escapedText}\\]\\(${escapedHref}\\)`, 'g');
  },

  // Generate deleted message reference string
  deletedMessageReference: (msgId) => {
    const { prefix } = MessageFormat.replyLinkFormat;
    const deletedText = MessageFormat.deletedReplyFormat(msgId);
    return `${prefix}${deletedText}`;
  },

  // Check if content contains a message with this ID
  containsMessage: (content, msgId) => {
    const marker = MessageFormat.sectionMarker(msgId);
    return content.includes(marker);
  },
};

// ------------------------------------------------------------------
// Resolve user mentions in message content
// ------------------------------------------------------------------
async function resolveUserMentions(content, msg) {
  if (!content || !content.includes('<@')) return content;

  // Find all user mentions <@userId> or <@!userId>
  const mentionPattern = /<@!?(\d+)>/g;
  const mentions = [...content.matchAll(mentionPattern)];

  let result = content;
  for (const match of mentions) {
    const userId = match[1];
    const mentionText = match[0];

    try {
      // Try to get user from message mentions first (cached)
      let user = msg.mentions.users.get(userId);

      // If not in mentions, try to fetch from client
      if (!user) {
        user = await msg.client.users.fetch(userId);
      }

      if (user) {
        // Try to get member to access display name (server nickname)
        // Use globalName (new Discord display name) or displayName from member, or fall back to username
        let displayName = user.globalName || user.username;
        try {
          const member = await msg.guild.members.fetch(userId);
          displayName = member.displayName || user.globalName || user.username;
        } catch {
          // If we can't get member info, use globalName or username
        }

        const fullMention = `@${displayName} (${user.username}#${user.discriminator} ${userId})`;
        result = result.replace(mentionText, fullMention);
      }
    } catch (error) {
      // If we can't resolve the user, leave the mention as-is or mark as unknown
      console.log(`⚠️  Could not resolve user mention ${userId}`);
      result = result.replace(mentionText, `@Unknown-User(${userId})`);
    }
  }

  return result;
}

// ------------------------------------------------------------------
// Format message content as markdown (with reply reference)
// ------------------------------------------------------------------
async function formatMessageMarkdown(msg) {
  // Get author display name (server nickname, globalName, or username)
  // Use globalName (new Discord display name) or displayName from member, or fall back to username
  let displayName = msg.author.globalName || msg.author.username;
  try {
    const member = await msg.guild.members.fetch(msg.author.id);
    displayName = member.displayName || msg.author.globalName || msg.author.username;
  } catch {
    // If we can't get member info, use globalName or username
  }

  const author = MessageFormat.metadata.author(
    displayName,
    msg.author.username,
    msg.author.discriminator,
    msg.author.id
  );
  const ts = MessageFormat.metadata.timestamp(formatTimestamp(msg.createdAt));
  const edited = msg.editedAt
    ? `\n${MessageFormat.metadata.modified(formatTimestamp(msg.editedAt))}`
    : '';

  // Handle reply reference - using MessageFormat
  let reference = '';
  if (msg.reference?.messageId) {
    const refId = msg.reference.messageId;
    try {
      const c = await msg.client.channels.fetch(msg.reference.channelId);
      if (c) await c.messages.fetch(refId);
      const { prefix, linkText, linkHref } = MessageFormat.replyLinkFormat;
      reference = `\n${prefix}[${linkText(refId)}](${linkHref(refId)})`;
    } catch {
      reference = `\n${MessagePatterns.deletedMessageReference(refId)}`;
    }
  }

  // Sanitize and wrap content in code block to prevent markdown injection
  let rawContent = msg.content || '';

  // Resolve user mentions before sanitizing
  rawContent = await resolveUserMentions(rawContent, msg);

  const { fence, content } = MessageFormat.codeBlock.sanitize(rawContent);
  const body = content ? `${fence}${MessageFormat.codeBlock.language}\n${content}\n${fence}` : '';

  // Format attachments using MessageFormat
  const atts = msg.attachments.size
    ? `\n\n${MessageFormat.attachments.header}\n\n${[...msg.attachments.values()]
      .map(a => MessageFormat.attachments.item(a.name, a.url))
      .join('\n')}`
    : '';

  // Use MessageFormat for the section marker
  return `\n${MessageFormat.sectionMarker(msg.id)}\n\n${author}\n${ts}${edited}${reference}\n\n${body}${atts}\n`;
}

// ------------------------------------------------------------------
// Check if message is in target channel or a target thread with specific tag
// ------------------------------------------------------------------
const isTargetMessage = msg =>
  CHANNEL_IDS.includes(msg.channel.id) ||
  (msg.channel.isThread?.() && msg.channel.parent?.id && CHANNEL_IDS.includes(msg.channel.parent.id) && hasMatchingTag(msg.channel));

// ------------------------------------------------------------------
// Write or append a message to the archive file
// ------------------------------------------------------------------
async function writeMessage(msg) {
  const channelId = msg.channel.id;
  const channelName = msg.channel.name || `Channel ${channelId}`;
  await ensureArchiveDir();
  const filePath = getArchiveFilePath(channelId);
  const existing = await readFileIfExists(filePath);

  // Use centralized pattern to check for duplicates
  if (existing && MessagePatterns.containsMessage(existing, msg.id)) {
    console.log(`⏭️ Duplicate skip ${msg.id}`);
    return;
  }

  const header = existing ? '' : `# ${channelName}\n\nOriginal conversation link: <https://discord.com/channels/${msg.guild.id}/${channelId}/${msg.id}>\n`;
  const formatted = await formatMessageMarkdown(msg);
  await fs.appendFile(filePath, header + formatted, 'utf8');
}

// ------------------------------------------------------------------
// Delete a message from the markdown file and update references
// ------------------------------------------------------------------
async function deleteMessage(channelId, messageId) {
  const filePath = getArchiveFilePath(channelId);
  const content = await readFileIfExists(filePath);
  if (!content) return;

  // Use centralized pattern to match message block
  const msgRegex = MessagePatterns.messageBlockRegex(messageId);
  if (!msgRegex.test(content)) {
    console.log(`⚠️  Message ${messageId} not found`);
    return;
  }

  msgRegex.lastIndex = 0; // Reset after test
  const updated = content
    .replace(msgRegex, '') // Remove the entire match (including leading newline captured in group 1)
    .replace(MessagePatterns.replyReferenceRegex(messageId), MessagePatterns.deletedMessageReference(messageId))
    .replace(/\n+$/, '\n'); // Ensure file ends with single newline

  await fs.writeFile(filePath, updated, 'utf8');
  console.log(`🗑️  Removed message ${messageId} + updated references`);
}

// ------------------------------------------------------------------
// Update a message in the markdown file
// ------------------------------------------------------------------
async function updateMessage(msg) {
  const filePath = getArchiveFilePath(msg.channel.id);
  const content = await readFileIfExists(filePath);
  if (!content) {
    await writeMessage(msg);
    return;
  }

  // Use centralized pattern to match message block
  const regex = MessagePatterns.messageBlockRegex(msg.id);
  if (!regex.test(content)) {
    console.log(`➕ Adding message ${msg.id}`);
    await writeMessage(msg);
    return;
  }

  if (!msg.editedAt) msg.editedAt = new Date();
  const formatted = await formatMessageMarkdown(msg);

  // Reset regex lastIndex after test
  regex.lastIndex = 0;

  // Replace, keeping the leading newline structure
  const replaced = content.replace(regex, (match, leadingNewline) => {
    return leadingNewline ? leadingNewline + formatted.trimStart() : formatted.trimStart();
  }).replace(/\n+$/, '\n'); // Ensure file ends with single newline

  await fs.writeFile(filePath, replaced, 'utf8');
  console.log(`✏️  Updated message ${msg.id}`);
}

// ------------------------------------------------------------------
// Check if a thread has any of the required tags
// ------------------------------------------------------------------
function hasMatchingTag(thread) {
  if (FILTER_TAGS.length === 0) return true;
  const tags = thread.appliedTags?.length ? thread.appliedTags : [];
  const parent = thread.parent;
  if (!parent?.availableTags?.length || !tags.length) return false;
  const names = tags.map(id => parent.availableTags.find(t => t.id === id)?.name?.toLowerCase()).filter(Boolean);
  return names.some(n => FILTER_TAGS.some(f => n.includes(f) || f.includes(n)));
}

// ------------------------------------------------------------------
// Get all threads from a forum channel
// ------------------------------------------------------------------
async function getAllThreads(channel) {
  const threads = [
    ...(await channel.threads.fetchActive()).threads.values(),
    ...(await channel.threads.fetchArchived()).threads.values(),
  ];
  const list = [...threads].filter(t => hasMatchingTag(t));
  console.log(`📚 Threads: ${list.length}/${[...threads].length} match in "${channel.name || channel.id}"`);
  if (FILTER_TAGS.length) console.log(`🏷️ Tags filter: ${FILTER_TAGS.join(', ')}`);
  return list;
}

// ------------------------------------------------------------------
// Bulk export – runs once at startup (or after a restart)
// ------------------------------------------------------------------
async function bulkExport(channel) {
  const checkpoints = await loadCheckpoints();
  console.log(`🔎 Bulk export (${Object.keys(checkpoints).length} checkpoints)`);
  if (channel.type === ChannelType.GuildForum) {
    for (const thread of await getAllThreads(channel)) {
      const checkPoint = getChannelCheckpoint(checkpoints, thread.id);
      console.log(`📝 Thread "${thread.name}" checkPoint=${checkPoint ?? 'none'}`);
      await exportChannelMessages(thread, checkPoint);
    }
  } else {
    const checkPoint = getChannelCheckpoint(checkpoints, channel.id);
    console.log(`📝 Channel "${channel.name || channel.id}" checkPoint=${checkPoint ?? 'none'}`);
    await exportChannelMessages(channel, checkPoint);
  }
  console.log('✅ Bulk export done.');
}

// ------------------------------------------------------------------
// Export messages from a specific channel or thread
// ------------------------------------------------------------------
async function exportChannelMessages(channel, checkpoint) {
  const opts = { limit: MAX_FETCH_SIZE, ...(checkpoint && { after: checkpoint }) };
  if (checkpoint) console.log(`📍 Checkpoint ${checkpoint} for ${channel.id}`);
  const fetched = await channel.messages.fetch(opts);
  if (!fetched.size) { if (checkpoint) console.log(`✅ No new messages for ${channel.id}`); return; }
  const list = [...fetched.values()].reverse().filter(m => !checkpoint || m.id > checkpoint);
  let latest = checkpoint;
  for (const m of list) { await writeMessage(m); if (!latest || m.id > latest) latest = m.id; }
  if (latest) await saveCheckpoint(channel.id, latest);
  console.log(`✅ Processed ${list.length} new messages for "${channel.id}"`);
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
  console.log(`📋 Monitoring ${CHANNEL_IDS.length} channel(s): ${CHANNEL_IDS.join(', ')}`);

  // Fetch and validate all channels
  const channels = [];
  for (const channelId of CHANNEL_IDS) {
    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildForum)) {
        console.error(`⚠️  Channel ${channelId} not found or not a text/forum channel. Skipping.`);
        continue;
      }
      channels.push(channel);
      console.log(`✅ Channel "${channel.name}" (${channelId}) added`);
    } catch (error) {
      console.error(`❌ Failed to fetch channel ${channelId}:`, error.message);
    }
  }

  if (channels.length === 0) {
    console.error("❌ No valid channels found. Exiting.");
    process.exit(1);
  }

  // Run the one‑time back‑fill for all channels
  for (const channel of channels) {
    console.log(`\n🔍 Processing channel "${channel.name}" (${channel.id})`);
    await bulkExport(channel);
  }

  // Listen for messageCreate, messageUpdate, messageDelete, and threadUpdate
  console.log("\n👂 Listening for new messages…");
});

client.on("messageCreate", async (msg) => {
  if (!isTargetMessage(msg)) return;
  const checkpoints = await loadCheckpoints();
  const checkpoint = checkpoints[msg.channel.id];

  // New thread or missed messages - fetch historical
  if (!checkpoint || msg.id > checkpoint) {
    const action = !checkpoint ? 'New thread' : 'Catching up';
    console.log(`🔄 ${action} channel "${msg.channel.name || msg.channel.id}"`);
    await exportChannelMessages(msg.channel, checkpoint);
    return;
  }

  // Real-time message
  await writeMessage(msg);
  await saveCheckpoint(msg.channel.id, msg.id);
});

client.on("messageUpdate", async (oldMsg, msg) => {
  if (msg.partial) {
    try { await msg.fetch(); }
    catch (error) { console.error('❌ Failed to fetch partial message:', error); return; }
  }
  if (!isTargetMessage(msg)) return;
  console.log(`🌍 Message ${msg.id} updated in "${msg.channel.name || msg.channel.id}"`);
  await updateMessage(msg);
});

client.on("messageDelete", async (msg) => {
  if (!isTargetMessage(msg)) return;
  console.log(`🌍 Message ${msg.id} deleted in "${msg.channel.name || msg.channel.id}"`);
  await deleteMessage(msg.channel.id, msg.id);
});

client.on("threadUpdate", async (oldThread, newThread) => {
  // Only care about threads in the target forum channels
  if (!newThread.parent?.id || !CHANNEL_IDS.includes(newThread.parent.id)) return;
  // Check if tags changed
  const oldTags = oldThread.appliedTags || [];
  const newTags = newThread.appliedTags || [];
  if (JSON.stringify(oldTags) === JSON.stringify(newTags)) return;
  console.log(`🌍 Thread "${newThread.name}" tags changed`);
  // Check if we went from no-match to match
  const oldMatch = hasMatchingTag(oldThread);
  const newMatch = hasMatchingTag(newThread);
  // If a tag was added that matches our filter - start archiving this thread
  if (!oldMatch && newMatch) {
    console.log(`🔄 Thread "${newThread.name}" now matches filter - catching up`);
    const checkpoints = await loadCheckpoints();
    const checkpoint = checkpoints[newThread.id];
    await exportChannelMessages(newThread, checkpoint);
  }
});

// ------------------------------------------------------------------
// Start the process
// ------------------------------------------------------------------
client.login(API_TOKEN).catch((err) => {
  console.error("❌ Failed to login:", err);
  process.exit(1);
});
