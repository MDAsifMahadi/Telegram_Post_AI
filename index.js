process.env.NTBA_FIX_319 = 1;
process.env.NTBA_FIX_350 = 0;

import 'dotenv/config';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
import input from 'input';
import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';
import path from 'path';
import AI from "./postHandler.js"

const apiId = parseInt(process.env.API_ID);
const apiHash = process.env.API_HASH;
const botToken = process.env.BOT_TOKEN;
const destinationChannel = process.env.DESTINATION_CHANNEL;
const stringSession = new StringSession(process.env.SESSION || '');

const requiredEnvVars = ['API_ID', 'API_HASH', 'BOT_TOKEN', 'DESTINATION_CHANNEL'];
for (const varName of requiredEnvVars) {
  if (!process.env[varName]) {
    console.error(`❌ Required env var ${varName} is missing`);
    process.exit(1);
  }
}

const adminId = process.env.ADMIN_ID ? parseInt(process.env.ADMIN_ID) : null;
const channelsConfigPath = 'channels.json';

function loadChannels() {
  try {
    if (fs.existsSync(channelsConfigPath)) {
      const data = JSON.parse(fs.readFileSync(channelsConfigPath, 'utf-8'));
      if (Array.isArray(data) && data.length > 0) return data;
    }
  } catch {}
  return (process.env.SOURCE_CHANNELS || '')
    .split(',')
    .map(ch => ch.trim())
    .filter(Boolean);
}

function saveChannels(channels) {
  try {
    fs.writeFileSync(channelsConfigPath, JSON.stringify(channels, null, 2));
  } catch (err) {
    console.error('⚠️ Config save error:', err.message);
  }
}

let sourceChannels = loadChannels();
if (!fs.existsSync(channelsConfigPath) && sourceChannels.length > 0) {
  saveChannels(sourceChannels);
}
let isRunning = true;

if (!fs.existsSync('downloads')) {
  fs.mkdirSync('downloads');
}

const bot = new TelegramBot(botToken, { polling: { interval: 300, params: { timeout: 10 } } });
const client = new TelegramClient(stringSession, apiId, apiHash, {
  connectionRetries: 5,
});

const processedMessages = new Map();
const mediaGroups = new Map();
const groupTimers = new Map();
const MAX_PROCESSED = 2000;
const POLL_CHECK_WINDOW_MS = 120_000;

function makeKey(channelId, msgId) {
  return `${channelId}:${msgId}`;
}

function markProcessed(key) {
  processedMessages.set(key, Date.now());
  if (processedMessages.size > MAX_PROCESSED) {
    const cutoff = Date.now() - 3_600_000;
    for (const [k, ts] of processedMessages) {
      if (ts < cutoff) processedMessages.delete(k);
    }
  }
}

function isProcessed(key) {
  return processedMessages.has(key);
}

function escapeHTML(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatMessage(text, entities = []) {
  if (!entities || entities.length === 0) return escapeHTML(text);

  const insertions = {};

  for (const entity of entities) {
    let startTag = '', endTag = '';

    const entityText = escapeHTML(text.slice(entity.offset, entity.offset + entity.length));

    switch (entity.className) {
      case 'MessageEntityBold':
        startTag = '<b>'; endTag = '</b>'; break;
      case 'MessageEntityItalic':
        startTag = '<i>'; endTag = '</i>'; break;
      case 'MessageEntityUnderline':
        startTag = '<u>'; endTag = '</u>'; break;
      case 'MessageEntityStrike':
        startTag = '<s>'; endTag = '</s>'; break;
      case 'MessageEntityCode':
        startTag = '<code>'; endTag = '</code>'; break;
      case 'MessageEntityPre':
        startTag = '<pre>'; endTag = '</pre>'; break;
      case 'MessageEntitySpoiler':
        startTag = '<span class="tg-spoiler">'; endTag = '</span>'; break;
      case 'MessageEntityBlockquote':
        startTag = '<blockquote>'; endTag = '</blockquote>'; break;
      case 'MessageEntityTextUrl':
        const safeUrl = entity.url ? entity.url.replace(/"/g, '&quot;') : '#';
        startTag = `<a href="${safeUrl}">`; endTag = '</a>'; break;
    }

    if (!insertions[entity.offset]) insertions[entity.offset] = { open: [], close: [] };
    if (!insertions[entity.offset + entity.length]) insertions[entity.offset + entity.length] = { open: [], close: [] };

    insertions[entity.offset].open.push(startTag);
    insertions[entity.offset + entity.length].close.unshift(endTag);
  }

  let result = '';

  for (let i = 0; i <= text.length; i++) {
    if (insertions[i]?.open) result += insertions[i].open.join('');
    if (i < text.length) result += escapeHTML(text[i]);
    if (insertions[i + 1]?.close) result += insertions[i + 1].close.join('');
  }

  return result;
}

function getFileExtension(mime) {
  if (mime.startsWith('video/')) return '.mp4';
  if (mime.startsWith('image/')) return '.jpg';
  if (mime.startsWith('audio/')) {
    if (mime.includes('mpeg')) return '.mp3';
    if (mime.includes('ogg')) return '.ogg';
    return '.ogg';
  }
  return '.bin';
}

async function downloadMedia(message) {
  try {
    const buffer = await client.downloadMedia(message.media, {});
    const mime = message.media?.document?.mimeType || 'image/jpeg';
    const extension = getFileExtension(mime);
    const filePath = path.join('downloads', `media_${message.id}${extension}`);
    fs.writeFileSync(filePath, buffer);

    const caption = formatMessage(message.message || '', message.entities || []);

    return { path: filePath, mime, caption };
  } catch (err) {
    console.error('❌ মিডিয়া ডাউনলোডে সমস্যা:', err.message);
    return null;
  }
}

function safeDelete(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (err) {
    console.error(`⚠️ ফাইল ডিলিট করতে সমস্যা: ${filePath}`, err.message);
  }
}

async function postMediaGroup(mediaItems) {
  try {
    const mediaGroup = mediaItems.map((item, index) => {
      const type = item.mime.startsWith('video') ? 'video' : 'photo';
      return {
        type,
        media: item.path,
        parse_mode: 'HTML',
        caption: index === 0 ? item.caption : undefined,
        ...(type === 'video' ? { supports_streaming: true } : {}),
      };
    });

    await bot.sendMediaGroup(destinationChannel, mediaGroup);

    for (const item of mediaItems) {
      safeDelete(item.path);
    }
  } catch (err) {
    console.error('❌ মিডিয়া গ্রুপ পাঠাতে সমস্যা:', err.message);
  }
}

async function postSingleMessage(message, srcChannel) {
  let file = null;
  try {
    if (message.media) {
      file = await downloadMedia(message);
      if (!file) return;
      const res = await AI(file.caption, bot, srcChannel);
      file.caption = res.text;
      const stats = fs.statSync(file.path);
      const sizeMB = stats.size / (1024 * 1024);
      const options = { caption: file.caption, parse_mode: 'HTML' };

      if (!res.should_post) {
        safeDelete(file.path);
        console.log('🚫 পোস্ট বাতিল: AI থেকে অনুমোদন নেই');
        return;
      }

      if (sizeMB > 50) {
        console.log(`⚠️ বড় ফাইল (${sizeMB.toFixed(2)}MB), userbot দিয়ে পাঠানো হচ্ছে`);
        await client.sendFile(destinationChannel, {
          file: file.path,
          caption: file.caption,
          forceDocument: false,
          supportsStreaming: true,
        });
      } else {
        const isVideo = file.mime.startsWith('video');
        if (isVideo) options.supports_streaming = true;

        await (isVideo
          ? bot.sendVideo(destinationChannel, file.path, options)
          : bot.sendPhoto(destinationChannel, file.path, options));
      }
    } else if (message.message) {
      const text = formatMessage(message.message, message.entities || []);
      const res = await AI(text, bot, srcChannel);
      console.log('📤 একক পোস্ট:', res.should_post);
      if (!res.should_post) {
        console.log('🚫 পোস্ট বাতিল: AI থেকে অনুমোদন নেই');
        return;
      }

      await bot.sendMessage(destinationChannel, res.text, { parse_mode: 'HTML' });
    }
  } catch (err) {
    console.error('❌ একক পোস্টে সমস্যা:', err.message);
  } finally {
    if (file) safeDelete(file.path);
  }
}

async function keepChannelsAlive() {
  try {
    await client.getDialogs({ limit: 1 });
  } catch (err) {
    console.error('⚠️ Dialogs refresh ব্যর্থ:', err.message);
  }
}

async function pollMissedMessages() {
  if (!isRunning) return;
  for (const uname of sourceChannels) {
    try {
      const messages = await client.getMessages(uname, { limit: 3 });
      const now = Date.now();
      for (const msg of messages) {
        if (!msg) continue;
        const msgDate = msg.date * 1000;
        if (now - msgDate > POLL_CHECK_WINDOW_MS) continue;

        const groupedId = msg.groupedId?.value;
        const msgKey = groupedId ? `g:${groupedId}` : makeKey(uname, msg.id);
        if (isProcessed(msgKey)) continue;

        const entity = await client.getEntity(uname);
        const channelId = String(entity.id?.value ?? entity.id ?? '');
        console.log(`📥 পোলিং থেকে পাওয়া গেছে: ${uname} (msg ${msg.id})`);
        markProcessed(msgKey);

        if (groupedId) {
          let groupMsgs = mediaGroups.get(groupedId);
          if (!groupMsgs) {
            groupMsgs = [];
            mediaGroups.set(groupedId, groupMsgs);
          }
          if (!groupMsgs.some(m => m.id === msg.id)) {
            groupMsgs.push(msg);
          }
          if (groupTimers.has(groupedId)) {
            clearTimeout(groupTimers.get(groupedId));
          }
          const timeout = setTimeout(async () => {
            try {
              const msgs = mediaGroups.get(groupedId);
              const unique = msgs.filter(
                (m, i, self) => i === self.findIndex(x => x.id === m.id)
              );
              const captionMsg = unique.find(m => m.message?.length);
              let caption = captionMsg
                ? formatMessage(captionMsg.message, captionMsg.entities || [])
                : '';
              const res = await AI(caption, bot, uname);
              if (!res.should_post) {
                console.log('🚫 গ্রুপ পোস্ট বাতিল (পোল): AI থেকে অনুমোদন নেই');
                mediaGroups.delete(groupedId);
                groupTimers.delete(groupedId);
                return;
              }
              caption = res.text;
              const items = [];
              for (const m of unique) {
                const media = await downloadMedia(m);
                if (media) items.push(media);
              }
              if (items.length > 0) {
                items[0].caption = caption;
                await postMediaGroup(items);
              } else if (caption) {
                await bot.sendMessage(destinationChannel, caption, { parse_mode: 'HTML' });
              }
              mediaGroups.delete(groupedId);
              groupTimers.delete(groupedId);
            } catch (err) {
              console.error('❌ গ্রুপ পোস্টে সমস্যা (পোল):', err.message);
              mediaGroups.delete(groupedId);
              groupTimers.delete(groupedId);
            }
          }, 2000);
          groupTimers.set(groupedId, timeout);
        } else {
          await postSingleMessage(msg, uname);
        }
      }
    } catch (err) {
      console.error(`⚠️ পোল ব্যর্থ: ${uname} -`, err.message);
    }
  }
}

async function main() {

  await client.start({
    phoneNumber: async () => await input.text('📱 ফোন নাম্বার দিন:'),
    password: async () => null,
    phoneCode: async () => await input.text('📨 কোড দিন:'),
    onError: err => console.error('❌ লগইন সমস্যা:', err.message),
  });

  console.log('✅ লগ ইন সফল');
  console.log('🔑 Session:\n', client.session.save());

  const channelEntities = new Map();
  const channelIdToName = new Map();
  const usernameToId = new Map();
  for (const uname of sourceChannels) {
    try {
      const ent = await client.getEntity(uname);
      const rawId = ent.id?.value !== undefined ? ent.id.value : ent.id;
      const idStr = String(rawId);
      channelEntities.set(idStr, ent);
      channelEntities.set(uname.replace('@', ''), ent);
      channelIdToName.set(idStr, uname.replace('@', ''));
      usernameToId.set(uname.replace('@', ''), idStr);
      console.log(`✅ লোড: ${uname} (ID: ${idStr})`);
    } catch (err) {
      console.error(`❌ লোড ব্যর্থ: ${uname} -`, err.message);
    }
  }

  setInterval(keepChannelsAlive, 30 * 1000);
  setInterval(pollMissedMessages, 45 * 1000);

  if (adminId) {
    bot.onText(/\/start/, async (msg) => {
      if (msg.from.id !== adminId) return;
      isRunning = true;
      await bot.sendMessage(msg.chat.id, '✅ Auto-post system started');
    });

    bot.onText(/\/stop/, async (msg) => {
      if (msg.from.id !== adminId) return;
      isRunning = false;
      await bot.sendMessage(msg.chat.id, '⏸️ Auto-post system paused');
    });

    bot.onText(/\/status/, async (msg) => {
      if (msg.from.id !== adminId) return;
      const status = isRunning ? '✅ Running' : '⏸️ Paused';
      const channels = sourceChannels.map((c, i) => `${i + 1}. ${c}`).join('\n');
      await bot.sendMessage(msg.chat.id,
        `📊 Status: ${status}\n📡 Destination: ${destinationChannel}\n📥 Sources:\n${channels || 'None'}`
      );
    });

    bot.onText(/\/add (.+)/, async (msg, match) => {
      if (msg.from.id !== adminId) return;
      let channel = match[1].trim();
      if (!channel) return;
      if (!channel.startsWith('@')) channel = `@${channel}`;
      if (sourceChannels.includes(channel)) {
        await bot.sendMessage(msg.chat.id, `⚠️ ${channel} already exists`);
        return;
      }
      try {
        const ent = await client.getEntity(channel);
        const rawId = ent.id?.value !== undefined ? ent.id.value : ent.id;
        const idStr = String(rawId);
        channelEntities.set(idStr, ent);
        channelEntities.set(channel.replace('@', ''), ent);
        channelIdToName.set(idStr, channel.replace('@', ''));
        usernameToId.set(channel.replace('@', ''), idStr);
        sourceChannels.push(channel);
        saveChannels(sourceChannels);
        await bot.sendMessage(msg.chat.id, `✅ Added ${channel}`);
      } catch (err) {
        await bot.sendMessage(msg.chat.id, `❌ Cannot resolve ${channel}: ${err.message}`);
      }
    });

    bot.onText(/\/remove (.+)/, async (msg, match) => {
      if (msg.from.id !== adminId) return;
      let channel = match[1].trim();
      if (!channel) return;
      if (!channel.startsWith('@')) channel = `@${channel}`;
      const idx = sourceChannels.indexOf(channel);
      if (idx === -1) {
        await bot.sendMessage(msg.chat.id, `⚠️ ${channel} not found`);
        return;
      }
      const name = channel.replace('@', '');
      const idStr = usernameToId.get(name);
      if (idStr) {
        channelEntities.delete(idStr);
        channelIdToName.delete(idStr);
        usernameToId.delete(name);
      }
      channelEntities.delete(name);
      sourceChannels.splice(idx, 1);
      saveChannels(sourceChannels);
      await bot.sendMessage(msg.chat.id, `✅ Removed ${channel}`);
    });

    bot.onText(/\/list/, async (msg) => {
      if (msg.from.id !== adminId) return;
      const list = sourceChannels.map((c, i) => `${i + 1}. ${c}`).join('\n');
      await bot.sendMessage(msg.chat.id, `📥 Source Channels (${sourceChannels.length}):\n${list || 'None'}`);
    });
  } else {
    console.log('⚠️ ADMIN_ID not set. Bot commands disabled.');
  }

  client.addEventHandler(async (event) => {
    if (!isRunning) return;
    const message = event.message;
    if (!message || !message.peerId) return;

    let channelId = '';
    let entity = null;
    if (message.peerId.channelId) {
      channelId = String(message.peerId.channelId?.value ?? message.peerId.channelId);
      entity = channelEntities.get(channelId);
    }
    if (!entity) {
      const chatId = message.chat?.id?.value ?? message.chat?.id ?? message.chatId;
      if (chatId) entity = channelEntities.get(String(chatId));
    }
    if (!entity) return;

    const srcName = entity.username || channelIdToName.get(channelId) || String(channelId);

    const groupedId = message.groupedId?.value;
    const messageKey = groupedId ? `g:${groupedId}` : makeKey(srcName, message.id);
    if (isProcessed(messageKey)) return;

    if (groupedId) {
      if (!mediaGroups.has(groupedId)) {
        mediaGroups.set(groupedId, []);
      }
      const group = mediaGroups.get(groupedId);
      if (!group.some(m => m.id === message.id)) {
        group.push(message);
      }

      if (groupTimers.has(groupedId)) {
        clearTimeout(groupTimers.get(groupedId));
      }

      const timeout = setTimeout(async () => {
        const group = mediaGroups.get(groupedId);
        markProcessed(messageKey);

        const uniqueMessages = group.filter(
          (msg, index, self) => index === self.findIndex(m => m.id === msg.id)
        );

        const captionMessage = uniqueMessages.find(m => m.message && m.message.length > 0);
        let caption = captionMessage ? formatMessage(captionMessage.message, captionMessage.entities || []) : '';

        const res = await AI(caption, bot, srcName);
        if (!res.should_post) {
          console.log('🚫 গ্রুপ পোস্ট বাতিল: AI থেকে অনুমোদন নেই');
          mediaGroups.delete(groupedId);
          groupTimers.delete(groupedId);
          return;
        }
        caption = res.text;

        const mediaItems = [];
        for (const msg of uniqueMessages) {
          const media = await downloadMedia(msg);
          if (media) mediaItems.push(media);
        }

        if (mediaItems.length > 0) {
          mediaItems[0].caption = caption;
          console.log(`📥 গ্রুপ পোস্ট (${mediaItems.length}): ${srcName}`);
          await postMediaGroup(mediaItems);
        } else {
          if (caption) {
            await bot.sendMessage(destinationChannel, caption, { parse_mode: 'HTML' });
          }
        }

        mediaGroups.delete(groupedId);
        groupTimers.delete(groupedId);
      }, 2000);

      groupTimers.set(groupedId, timeout);
    } else {
      markProcessed(messageKey);
      console.log(`📥 একক পোস্ট: ${srcName}`);
      await postSingleMessage(message, srcName);
    }
  }, new NewMessage({}));
}

main().catch(err => {
  console.error('❌ Fatal error:', err.message);
  process.exit(1);
});
