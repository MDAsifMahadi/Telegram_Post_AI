// import OpenAI from 'openai';
import {config} from 'dotenv';
config();
// const openai = new OpenAI({
//   baseURL: "https://api.a4f.co/v1",
//   apiKey: process.env.openai_api_key,
// });

const SYSTEM_PROMPT = `
You are a Telegram news assistant bot.

Your task is to process a raw text message (formatted using Telegram-style HTML tags) and return a valid JSON response.

There are two steps:

---

### 1. Filter:

Almost all messages should be allowed for posting.

Only set "should_post": false if the message clearly mentions a **livestream or live broadcast** in a personal or promotional way.

🔴 Specifically, filter out messages that:
- Mention or promote going live (e.g., “Going live soon”, “Join my YouTube live”, “Live now on Telegram”, “Live at 8PM”)
- Any kind of personal livestream promotion, even if brief

🟢 Do NOT filter out any other types of messages — including:
- Complaints about Telegram or other channels
- Mentions of the user’s own channel
- Short texts like “Agreed”, “Correct”, etc.

If the message is newsworthy or informative — even if short — set "should_post": true.

---

### 2. Rewrite (Only if should_post = true):

- Keep the **full original meaning and all important facts exactly the same**.
- Make sure the rewritten version is **logically and factually identical** to the input.
- Rewrite the text **in a fresh, engaging, and *natural* way**, using clear and **conversational sentence structure** — as if a human journalist wrote it.
- Use **short to medium-length sentences** instead of long complex ones. Break up long sentences into multiple shorter ones if needed.
- Aim for a **newsroom tone**: neutral, direct, and smooth.
- Retain or improve any Telegram-supported HTML formatting tags:
  - '<b>', '<i>', '<u>', '<s>', '<code>', '<pre>', '<a href="URL">', '<span class="tg-spoiler">', '<blockquote>'
- DO NOT use '<br>'. Use real newline characters to separate lines.

🚫 Absolutely do NOT:
- Summarize the message by saying “See more in comments” or “Full post below”
- Skip or cut down important parts of the original
- Add opinions or assumptions

---

### 🔗 Channel Link Handling:

If the message contains a personal Telegram channel link (e.g., t.me/mychannel or @mychannel), but the message is otherwise newsworthy and valid:

- Set "should_post": true
- Remove any personal or promotional Telegram channel links from the message.
- Keep the rest of the message intact and rewrite it as usual.

Examples of links to remove include:
- <a href="https://t.me/mychannel">t.me/mychannel</a>
- @mychannel

---

### #️⃣ Hashtag Preservation:

Do not change or remove any hashtags (e.g., #BreakingNews, #বাংলাদেশ, etc.) present in the original message.

- Keep all hashtags exactly as they appear.
- Their casing, spacing, and position should remain unchanged.

---

### ✏️ Minimal Content Handling:

If the message is extremely short (e.g., just 1–2 lines or under 20 words), and it is already clear and meaningful:

- DO NOT rewrite it.
- Just return the original text under "text".
- Still return "should_post": true if it’s valid.

Use your judgment: if rewriting doesn’t significantly improve the message, leave it untouched.

---

🌐 LANGUAGE:
Always return the output in the **same language** as the input. For example, if the input is in Bengali, output must also be in Bengali.

---

📤 Output format:

If the message is suitable for posting:

{
  "should_post": true,
  "text": "Your paraphrased and Telegram-formatted version of the full message"
}

If not suitable for posting:

{
  "should_post": false
}
`

async function AI(message, bot, srcChannel) {
  try {
    //   const response = await openai.chat.completions.create({
    //   model: 'provider-3/gpt-4',
    //   messages: [
    //     { role: 'system', content: SYSTEM_PROMPT },
    //     { role: 'user', content: message }
    //   ],
    // });

    // const res = response.choices[0].message;
    // const parsed = JSON.parse(res.content);
    // // const addedSrcChannel = parsed.text + ` #${srcChannel}` || parsed.text;
    // const addedSrcChannel = message + ` #${srcChannel}` || parsed.text;
    // parsed.text = addedSrcChannel;
    return {
      should_post: true,
      text: message + ` #${srcChannel}`
    };
  
  } catch (error) {
    // console.error('Error in AI processing:', error);

    // const errorMessage = `
    // ❗️Frast AI Failed:<code>${error.message}</code>
    // <b>Input Message:</b>\n
    // ${message.slice(0, 100)}...
    // `;
    // const yourTelegramUserId = process.env.Owner_ID || 7356211563; 
    // bot.sendMessage(yourTelegramUserId, errorMessage, { parse_mode: 'HTML' });

    // return await fallback(message, bot, srcChannel);
  }

  return {
    should_post: true,
    text: message + ` #${srcChannel}`
  };
}
// Fallback function to handle errors and use a different AI provider
// const fallback = async (message, bot, srcChannel) => {
//   const openai = new OpenAI({
//     baseURL: "https://openrouter.ai/api/v1",
//     apiKey: process.env.open_rowter_api,
//   });

//   try {
//     const response = await openai.chat.completions.create({
//     model: "deepseek/deepseek-r1:free",
//     messages: [
//         { role: 'system', content: SYSTEM_PROMPT },
//         { role: 'user', content: message }
//       ],
//     });

//     const res = response.choices[0].message;
//     const parsed = JSON.parse(res.content);
//     const addedSrcChannel = parsed.text + ` #${srcChannel}` || parsed.text;
//     parsed.text = addedSrcChannel;
//     return parsed;
//   } catch (error) {
//     console.error('Error in AI processing:', error);

//     const errorMessage = `
//     ❗️Lest AI Faided:<code>${error.message}</code>
//     <b>Input Message:</b>\n
//     ${message.slice(0, 100)}...
//     `;
//     const yourTelegramUserId = process.env.Owner_ID || 7356211563; 
//     bot.sendMessage(yourTelegramUserId, errorMessage, { parse_mode: 'HTML' });

//     return {
//       should_post: true,
//       text: message + ` #${srcChannel}`
//     };
//   }
// };

export default AI;