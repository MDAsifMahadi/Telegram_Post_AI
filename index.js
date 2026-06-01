process.env.NTBA_FIX_319 = 1;
process.env.NTBA_FIX_350 = 0;

import 'dotenv/config';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import input from 'input';
import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';
import path from 'path';
import AI from "./postHandler.js"

const apiId = parseInt(process.env.API_ID);
const apiHash = process.env.API_HASH;
const botToken = process.env.BOT_TOKEN;
const sourceChannels = (process.env.SOURCE_CHANNELS || '')
  .split(',')
  .map(ch => ch.trim())
  .filter(Boolean);
const destinationChannel = process.env.DESTINATION_CHANNEL;
const stringSession = new StringSession(process.env.SESSION || '');

if (!fs.existsSync('downloads')) {
  fs.mkdirSync('downloads');
}

const bot = new TelegramBot(botToken, { polling: false });
const client = new TelegramClient(stringSession, apiId, apiHash, {
  connectionRetries: 5,
});

const processedMessages = new Set();
const mediaGroups = new Map();
const groupTimers = new Map();

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
    for (const uname of sourceChannels) {
      try {
        await client.getMessages(uname, { limit: 1 });
      } catch (e) {
      }
    }
  } catch (e) {
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
  for (const uname of sourceChannels) {
    try {
      const ent = await client.getEntity(uname);
      channelEntities.set(ent.id.value, ent);
      console.log(`✅ লোড: ${uname}`);
    } catch {
      console.error(`❌ লোড ব্যর্থ: ${uname}`);
    }
  }

  setInterval(keepChannelsAlive, 30 * 1000);

  client.addEventHandler(async (event) => {
    const message = event.message;
    if (!message || !message.peerId || !message.peerId.channelId) return;

    const channelId = message.peerId.channelId.value;
    if (!channelEntities.has(channelId)) return;

    const groupedId = message.groupedId?.value;
    const messageKey = groupedId || message.id;
    if (processedMessages.has(messageKey)) return;

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
        processedMessages.add(groupedId);

        const uniqueMessages = group.filter(
          (msg, index, self) => index === self.findIndex(m => m.id === msg.id)
        );

        const captionMessage = uniqueMessages.find(m => m.message && m.message.length > 0);
        let caption = captionMessage ? formatMessage(captionMessage.message, captionMessage.entities || []) : '';

        const res = await AI(caption, bot, channelEntities.get(channelId).username);
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
          console.log(`📥 গ্রুপ পোস্ট (${mediaItems.length}): ${channelEntities.get(channelId).username}`);
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
      processedMessages.add(message.id);
      console.log(`📥 একক পোস্ট: ${channelEntities.get(channelId).username}`);
      await postSingleMessage(message, channelEntities.get(channelId).username);
    }
  });
}

main();
