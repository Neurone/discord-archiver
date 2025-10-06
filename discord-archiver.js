#!/usr/bin/env node
import dotenvx from '@dotenvx/dotenvx';
dotenvx.config()

import { Client, GatewayIntentBits, Partials, ChannelType } from "discord.js";
import { promises as fs } from "fs";
import path from "path";

// -------------------- CONFIGURATION --------------------
const API_TOKEN = process.env.API_TOKEN; // keep secret!
const CHANNEL_ID = process.argv[2] || process.env.CHANNEL_ID; // from CLI arg or env var or exit
const MAX_FETCH_SIZE = Number(process.env.MAX_FETCH_SIZE) || 100; // max allowed by Discord API
const OUTPUT_ROOT = process.env.OUTPUT_ROOT || "./archive"; // where markdown lands
const CHECKPOINT_PATH = process.env.CHECKPOINT_PATH || "./checkpoints.json"; // tiny JSON file
const FILTER_TAGS = (process.env.FILTER_TAGS || '')
  .split(',')
  .map(t => t.trim().toLowerCase())
  .filter(Boolean);
// ---------------------------------------------------------

if (!API_TOKEN) {
  console.error("❌ Please set the API_TOKEN environment variable.");
  process.exit(1);
}

if (!CHANNEL_ID) {
  console.error("❌ Please provide a CHANNEL_ID either via:");
  console.error("   • Command line argument: node discord-archiver.js <your_channel_id>");
  console.error("   • Environment variable: CHANNEL_ID=your_channel_id");
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
// Format message content as markdown (with reply reference)
// ------------------------------------------------------------------
async function formatMessageMarkdown(msg) {
  const author = `${msg.author.username}#${msg.author.discriminator} (${msg.author.id})`;
  const ts = formatTimestamp(msg.createdAt);
  const edited = msg.editedAt ? `\n**MODIFIED** last time at *${formatTimestamp(msg.editedAt)}*` : '';

  // Handle reply reference
  let reference = '';
  if (msg.reference?.messageId) {
    const refId = msg.reference.messageId;
    try {
      const c = await msg.client.channels.fetch(msg.reference.channelId);
      if (c) await c.messages.fetch(refId);
      reference = `\nin reply to [${refId}](#${refId})`;
    } catch {
      reference = `\nin reply to **DELETED MESSAGE** (${refId})`;
    }
  }

  const body = (msg.content || '').replace(/`/g, "`\u200b");
  const atts = msg.attachments.size
    ? `\n**Attachments:**\n${[...msg.attachments.values()].map(a => `- [${a.name}](${a.url})`).join('\n')}`
    : '';
  return `### Message ${msg.id}\nby ${author}\nat *${ts}*${edited}${reference}\n\n${body}\n${atts}\n---\n\n`;
}

// ------------------------------------------------------------------
// Check if message is in target channel/thread
// ------------------------------------------------------------------
const isTargetMessage = msg =>
  msg.channel.id === CHANNEL_ID ||
  (msg.channel.isThread?.() && msg.channel.parent?.id === CHANNEL_ID && hasMatchingTag(msg.channel));

// ------------------------------------------------------------------
// Write or append a message to the archive file
// ------------------------------------------------------------------
async function writeMessage(msg) {
  const channelId = msg.channel.id;
  const channelName = msg.channel.name || `Channel ${channelId}`;
  await ensureArchiveDir();
  const filePath = getArchiveFilePath(channelId);
  const existing = await readFileIfExists(filePath);
  if (existing?.includes(`### Message ${msg.id}`)) {
    console.log(`⏭️ Duplicate skip ${msg.id}`); return;
  }
  const header = existing ? '' : `# ${channelName}\n\n`;
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
  const msgRegex = new RegExp(`### Message ${messageId}\\n[\\s\\S]*?\\n---\\n\\n`, 'g');
  if (!msgRegex.test(content)) { console.log(`⚠️  Message ${messageId} not found`); return; }
  const updated = content
    .replace(msgRegex, '')
    .replace(new RegExp(`in reply to \\[${messageId}\\]\\(#${messageId}\\)`, 'g'), `in reply to **DELETED MESSAGE** (${messageId})`);
  await fs.writeFile(filePath, updated, 'utf8');
  console.log(`🗑️  Removed message ${messageId} + updated references`);
}

// ------------------------------------------------------------------
// Update a message in the markdown file
// ------------------------------------------------------------------
async function updateMessage(msg) {
  const filePath = getArchiveFilePath(msg.channel.id);
  const content = await readFileIfExists(filePath);
  if (!content) { await writeMessage(msg); return; }
  const regex = new RegExp(`(### Message ${msg.id}\\n)([\\s\\S]*?)(\\n---\\n)`, 'm');
  if (!regex.test(content)) { console.log(`➕ Adding message ${msg.id}`); await writeMessage(msg); return; }
  if (!msg.editedAt) msg.editedAt = new Date();
  const formatted = await formatMessageMarkdown(msg);
  const replaced = content.replace(regex, formatted);
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

  const channel = await client.channels.fetch(CHANNEL_ID);
  if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildForum)) {
    console.error("❌ Target channel not found or not a text/forum channel.");
    process.exit(1);
  }

  // Run the one‑time back‑fill (skipping anything already saved)
  await bulkExport(channel);

  // Listen for messageCreate, messageUpdate, messageDelete, and threadUpdate
  console.log("👂 Listening for new messages…");
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
  // Only care about threads in the target forum channel
  if (newThread.parent?.id !== CHANNEL_ID) return;
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