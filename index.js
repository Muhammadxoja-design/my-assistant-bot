// index.js
import { Telegraf } from "telegraf";
import axios from "axios";
import fs from "fs/promises";
import path from "path";
import "dotenv/config";

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID && process.env.ADMIN_ID.toString();
const DB_FILE = path.resolve(process.cwd(), "db.json");

const SERPER_API_KEY = process.env.SERPER_API_KEY || "";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "models/text-bison-001";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const COHERE_API_KEY = process.env.COHERE_API_KEY || "";
const PREFERRED_AI = (process.env.PREFERRED_AI || "").toLowerCase();
const DELETED_GROUP_ID = process.env.DELETED_GROUP_ID
  ? process.env.DELETED_GROUP_ID.toString()
  : "";
const AI_ENABLED = process.env.AI_ENABLED === "true";

// Basic env check
if (!BOT_TOKEN || !ADMIN_ID) {
  console.error(
    "BOT_TOKEN va ADMIN_ID .env da belgilanmagan. Iltimos to'ldiring."
  );
  process.exit(1);
}

console.log("📦 index.js yuklandi");
console.log("AI_ENABLED =", AI_ENABLED);

const bot = new Telegraf(BOT_TOKEN);

// -------------------- DB helpers --------------------
async function loadDB() {
  try {
    const raw = await fs.readFile(DB_FILE, "utf8");
    const parsed = JSON.parse(raw);

    const users =
      typeof parsed.users === "object" && parsed.users ? parsed.users : {};
    const autoReplies = Array.isArray(parsed.autoReplies)
      ? parsed.autoReplies
      : [];
    const conversations =
      typeof parsed.conversations === "object" && parsed.conversations
        ? parsed.conversations
        : {};
    const step =
      typeof parsed.step === "object" && parsed.step !== null
        ? parsed.step
        : {};
    const messages =
      typeof parsed.messages === "object" && parsed.messages !== null
        ? parsed.messages
        : {};
    const deletedLog = Array.isArray(parsed.deletedLog)
      ? parsed.deletedLog
      : [];

    return { users, autoReplies, conversations, step, messages, deletedLog };
  } catch (err) {
    return {
      users: {},
      autoReplies: [],
      conversations: {},
      step: {},
      messages: {},
      deletedLog: [],
    };
  }
}

async function saveDB(db) {
  const toSave = {
    users: db.users || {},
    autoReplies: Array.isArray(db.autoReplies) ? db.autoReplies : [],
    conversations: db.conversations || {},
    step: typeof db.step === "object" && db.step !== null ? db.step : {},
    messages:
      typeof db.messages === "object" && db.messages !== null
        ? db.messages
        : {},
    deletedLog: Array.isArray(db.deletedLog) ? db.deletedLog : [],
  };
  await fs.writeFile(DB_FILE, JSON.stringify(toSave, null, 2), "utf8");
}

// -------------------- Utilities --------------------
function ensureConversation(db, chatId) {
  if (!db.conversations[chatId]) db.conversations[chatId] = {};
}
function resolveRole(db, userId) {
  if (!userId) return "unknown";
  if (String(userId) === ADMIN_ID) return "owner";
  return db.users?.[String(userId)]?.role || "unknown";
}
function personaFallback(role, userName = "Foydalanuvchi") {
  return {
    tone:
      role === "friend"
        ? "do'stona"
        : role === "contact"
        ? "rasmiy"
        : "ehtiyotkor",
    greeting:
      role === "friend"
        ? `Salom, ${userName}!`
        : `Assalomu alaykum, ${userName}.`,
    style: role === "friend" ? "Qisqa, norasmiy." : "Rasmiy va aniq.",
    doNotReveal: "Shaxsiy yoki moliyaviy ma'lumotlarni so'ramang.",
    sample_first_message:
      role === "friend"
        ? `Salom ${userName}! Qanday yordam bera olaman?`
        : `Assalomu alaykum, qanday savolingiz bor?`,
    signature_hint: "— Bot",
  };
}

// Escape helper for HTML-only sends (avoid double-escaping when using entities)
function escapeHtmlUnlessHtml(text, use_html) {
  if (!text) return "";
  if (use_html) return text;
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// -------------------- Retry helper --------------------
async function retryRequest(fn, { retries = 2, delay = 700 } = {}) {
  let i = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      i++;
      const status = err?.response?.status;
      if (i > retries || (status >= 400 && status < 500 && status !== 429)) {
        throw err;
      }
      const wait = delay * Math.pow(2, i - 1);
      console.warn(
        `Retry #${i} after error: ${err?.message || err}. waiting ${wait}ms`
      );
      await new Promise((res) => setTimeout(res, wait));
    }
  }
}

// -------------------- Search & AI helpers --------------------
async function serperSearch(q, opts = {}) {
  if (!SERPER_API_KEY) throw new Error("SERPER_API_KEY mavjud emas.");
  const url = "https://google.serper.dev/search";
  const body = { q, gl: opts.gl || "us", hl: opts.hl || "en" };
  const resp = await retryRequest(
    () =>
      axios.post(url, body, {
        headers: {
          "Content-Type": "application/json",
          "X-API-KEY": SERPER_API_KEY,
        },
        timeout: 20000,
      }),
    { retries: 1, delay: 500 }
  );
  return resp.data;
}

async function generateWithGemini(prompt, opts = {}) {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY yo'q");
  const model = opts.model || GEMINI_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta2/${model}:generateText?key=${GEMINI_API_KEY}`;
  const body = {
    prompt: { text: prompt },
    temperature: opts.temperature ?? 0.2,
    maxOutputTokens: opts.maxOutputTokens ?? 512,
  };
  const r = await retryRequest(
    () =>
      axios.post(url, body, {
        headers: { "Content-Type": "application/json" },
        timeout: 25000,
      }),
    { retries: 1, delay: 700 }
  );
  if (r.data?.candidates?.[0]?.output) return r.data.candidates[0].output;
  if (r.data?.outputs?.[0]?.content) {
    return r.data.outputs[0].content.map((p) => p.text || "").join("");
  }
  return JSON.stringify(r.data);
}

async function generateWithOpenAI(prompt, opts = {}) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY yo'q");
  const resp = await retryRequest(
    () =>
      axios.post(
        "https://api.openai.com/v1/chat/completions",
        {
          model: opts.model || "gpt-4o-mini",
          messages: [{ role: "user", content: prompt }],
          max_tokens: opts.maxTokens || 512,
          temperature: opts.temperature ?? 0.2,
        },
        {
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
          timeout: 25000,
        }
      ),
    { retries: 1, delay: 800 }
  );
  const text = resp.data?.choices?.[0]?.message?.content;
  return text || JSON.stringify(resp.data);
}

async function generateWithCohere(prompt, opts = {}) {
  if (!COHERE_API_KEY) throw new Error("COHERE_API_KEY yo'q");
  const resp = await retryRequest(
    () =>
      axios.post(
        "https://api.cohere.ai/generate",
        {
          model: opts.model || "command-xlarge-nightly",
          prompt,
          max_tokens: opts.maxTokens || 300,
          temperature: opts.temperature ?? 0.2,
        },
        {
          headers: {
            Authorization: `Bearer ${COHERE_API_KEY}`,
            "Content-Type": "application/json",
          },
          timeout: 25000,
        }
      ),
    { retries: 2, delay: 1000 }
  );
  return resp.data?.generations?.[0]?.text || JSON.stringify(resp.data);
}

function buildGenPrompt({ persona, userMessage, searchResults = [] }) {
  const top = (searchResults || [])
    .slice(0, 5)
    .map(
      (r, i) =>
        `${i + 1}. ${r.title || ""}\n${r.snippet || ""}\n${
          r.link || r.displayed_link || ""
        }`
    )
    .join("\n\n");
  const personaNote = persona
    ? `Persona tone: ${persona.tone}. Style: ${persona.style}. Avoid: ${persona.doNotReveal}`
    : "";
  return `Siz professional yordamchisiz. ${personaNote}\n\nFoydalanuvchi so'rovi:\n"${userMessage}"\n\nKontekst (qidiruv):\n${top}\n\nIltimos, 1-3 jumla ichida qisqa, aniq javob bering va kerak bo'lsa URL manzilga ishora qiling. Oxirida qo'shing: (Bu javob bot tomonidan yaratilgan.)`;
}

async function generateAIResponse({ persona, userMessage, serperData }) {
  // if AI disabled, don't call providers at all
  if (!AI_ENABLED) {
    return (
      persona?.sample_first_message ||
      persona?.greeting ||
      "Salom! Avtomatik javoblar faol."
    );
  }

  const searchResults = (serperData?.organic || []).map((it) => ({
    title: it.title,
    snippet: it.snippet || it.description,
    link: it.link || it.displayed_link,
  }));
  const prompt = buildGenPrompt({ persona, userMessage, searchResults });

  const order = [];
  if (PREFERRED_AI) order.push(PREFERRED_AI);
  order.push("gemini", "openai", "cohere");
  const tried = new Set();
  let lastError = null;

  for (const name of order) {
    if (!name) continue;
    const n = name.toLowerCase();
    if (tried.has(n)) continue;
    tried.add(n);

    try {
      if (n === "gemini" && GEMINI_API_KEY) {
        const out = await generateWithGemini(prompt, {
          model: GEMINI_MODEL,
          temperature: 0.2,
          maxOutputTokens: 400,
        });
        return String(out).trim();
      }
      if (n === "openai" && OPENAI_API_KEY) {
        const out = await generateWithOpenAI(prompt, {
          model: "gpt-4o-mini",
          temperature: 0.2,
        });
        return String(out).trim();
      }
      if (n === "cohere" && COHERE_API_KEY) {
        const out = await generateWithCohere(prompt, {
          model: "command-xlarge-nightly",
          temperature: 0.2,
        });
        return String(out).trim();
      }
    } catch (err) {
      lastError = err;
      console.warn(
        `AI provider ${n} failed:`,
        err?.response?.data || err?.message || err
      );
    }
  }

  if ((searchResults || []).length > 0) {
    const top = searchResults
      .slice(0, 3)
      .map((r, i) => `${i + 1}. ${r.title}\n${r.link}\n${r.snippet}`)
      .join("\n\n");
    return `🔎 Top natijalar:\n\n${top}\n\n(Bu javob bot tomonidan yaratilgan.)`;
  }

  return (
    persona?.sample_first_message ||
    persona?.greeting ||
    "Salom! Hozir AI provayderlari mavjud emas."
  );
}

// -------------------- Message storage helpers --------------------
async function storeIncomingMessage(db, chatId, messageId, msgObj) {
  if (!db.messages) db.messages = {};
  if (!db.messages[chatId]) db.messages[chatId] = {};
  db.messages[chatId][String(messageId)] = {
    saved_at: Date.now(),
    ...msgObj,
  };
  await saveDB(db);
  console.log(`Stored message snapshot: chat=${chatId} id=${messageId}`);
}

async function forwardToDeletedGroup(db, original) {
  if (!DELETED_GROUP_ID) {
    console.warn("DELETED_GROUP_ID not set; cannot forward deleted messages.");
    return;
  }

  const header = `⚠️ O'chirilgan xabar\nFrom: ${
    original.fromName || "Unknown"
  } (id: ${original.fromId || "?"})\nChat: ${original.chatId}\nMessageId: ${
    original.messageId
  }\nSent at: ${new Date((original.date || 0) * 1000).toISOString()}\n\n`;

  try {
    if (original.text) {
      await bot.telegram.sendMessage(
        DELETED_GROUP_ID,
        header + (original.text || ""),
        original.use_html ? { parse_mode: "HTML" } : {}
      );
    }

    if (original.photoFileId) {
      await bot.telegram.sendPhoto(DELETED_GROUP_ID, original.photoFileId, {
        caption: header + (original.caption || ""),
        parse_mode: original.caption_html ? "HTML" : undefined,
      });
    }

    if (original.documentFileId) {
      await bot.telegram.sendDocument(
        DELETED_GROUP_ID,
        original.documentFileId,
        {
          caption: header + (original.caption || ""),
          parse_mode: original.caption_html ? "HTML" : undefined,
        }
      );
    }

    if (original.stickerFileId) {
      await bot.telegram.sendSticker(DELETED_GROUP_ID, original.stickerFileId);
    }

    if (original.voiceFileId) {
      await bot.telegram.sendVoice(DELETED_GROUP_ID, original.voiceFileId, {
        caption: header + (original.caption || ""),
      });
    }

    if (!Array.isArray(db.deletedLog)) db.deletedLog = [];
    db.deletedLog.push({
      forwarded_at: Date.now(),
      originalMeta: original,
    });
    await saveDB(db);
    console.log(`Forwarded deleted message to group ${DELETED_GROUP_ID}`);
  } catch (e) {
    console.error("Failed to forward to deleted group:", e?.message || e);
  }
}

// Choose entities over parse_mode HTML
function sendOptionsForResponse(r) {
  const opt = {};
  if (r && r.entities) {
    opt.entities = r.entities;
  } else if (r && r.use_html) {
    opt.parse_mode = "HTML";
  }
  return opt;
}

// Duplicate reply guard: returns true if allowed to send, and marks last reply
async function canSendAndMark(
  db,
  chatId,
  text,
  save = true,
  windowMs = 1000 * 60 * 5
) {
  if (!db.conversations) db.conversations = {};
  if (!db.conversations[chatId]) db.conversations[chatId] = {};
  const last = db.conversations[chatId].lastBotReply || null;
  const now = Date.now();

  if (last && last.text === text && now - (last.at || 0) < windowMs) {
    return false;
  }

  if (save) {
    db.conversations[chatId].lastBotReply = { text, at: now };
    await saveDB(db);
  }
  return true;
}

// -------------------- Keyboards & admin --------------------
const mainKeyboard = {
  reply_markup: {
    keyboard: [
      ["Add auto reply ✉️", "Remove auto reply 🚫"],
      ["List auto replies 📋"],
    ],
    resize_keyboard: true,
  },
};
const backKeyboard = {
  reply_markup: { keyboard: [["Back 🔙"]], resize_keyboard: true },
};

// -------------------- Debug: incoming update preview --------------------
bot.on("update", async (ctx, next) => {
  try {
    const preview = JSON.stringify(
      ctx.update || {},
      (k, v) => {
        if (k === "photo" || k === "file_size" || k === "thumb")
          return undefined;
        return v;
      },
      2
    ).slice(0, 1600);
    console.log("Incoming update preview:", preview);
  } catch (e) {
    console.log("Incoming update (could not stringify):", typeof ctx.update);
  }
  return next();
});

// -------------------- Admin commands --------------------
bot.start(async (ctx) => {
  const chatId = String(ctx.chat.id);
  if (chatId !== ADMIN_ID) return ctx.reply("Bu bot faqat admin uchun.");
  const db = await loadDB();
  if (!Array.isArray(db.autoReplies)) db.autoReplies = [];
  if (typeof db.step !== "object" || db.step === null) db.step = {};
  await saveDB(db);
  ctx.reply("Assalomu alaykum, admin. Tanlang:", mainKeyboard);
});

bot.hears("Add auto reply ✉️", async (ctx) => {
  if (String(ctx.chat.id) !== ADMIN_ID) return;
  const db = await loadDB();
  if (!Array.isArray(db.autoReplies)) db.autoReplies = [];
  if (typeof db.step !== "object" || db.step === null) db.step = {};
  db.step[ADMIN_ID] = { action: "add_trigger" };
  await saveDB(db);
  await ctx.reply(
    "Qaysi trigger so'zni qo'shmoqchisiz? (masalan: salom)",
    backKeyboard
  );
});

bot.hears("Remove auto reply 🚫", async (ctx) => {
  if (String(ctx.chat.id) !== ADMIN_ID) return;
  const db = await loadDB();
  if (!Array.isArray(db.autoReplies) || db.autoReplies.length === 0)
    return ctx.reply("Auto-reply ro'yxati bo'sh.", mainKeyboard);

  let list = "Auto-replylar:\n\n";
  db.autoReplies.forEach((r, i) => {
    list += `${i + 1}. ${r.trigger} (${(r.responses || []).length} javob)\n`;
  });

  if (typeof db.step !== "object" || db.step === null) db.step = {};
  db.step[ADMIN_ID] = { action: "remove_choose" };
  await saveDB(db);
  await ctx.reply(
    list + "\nO'chirish uchun raqam yuboring yoki Back.",
    backKeyboard
  );
});

bot.hears("List auto replies 📋", async (ctx) => {
  if (String(ctx.chat.id) !== ADMIN_ID) return;
  const db = await loadDB();
  if (!Array.isArray(db.autoReplies) || db.autoReplies.length === 0)
    return ctx.reply("Auto-reply ro'yxati bo'sh.", mainKeyboard);
  let list = "Auto-replylar:\n\n";
  db.autoReplies.forEach((r, i) => {
    list += `${i + 1}. ${r.trigger}\n`;
  });
  await ctx.reply(list, mainKeyboard);
});

bot.hears("Back 🔙", async (ctx) => {
  if (String(ctx.chat.id) !== ADMIN_ID)
    return ctx.reply("Bosh menyu", mainKeyboard);
  const db = await loadDB();
  if (typeof db.step !== "object" || db.step === null) db.step = {};
  db.step[ADMIN_ID] = null;
  await saveDB(db);
  return ctx.reply("Bosh menyu", mainKeyboard);
});

// -------------------- Main message handler (admin step + storage) --------------------
bot.on("message", async (ctx) => {
  // 1) Store incoming message snapshot for future (so we can forward if deleted)
  try {
    const incomingChatId = String(ctx.chat.id);
    const incomingMessageId = ctx.message?.message_id || ctx.message?.messageId;
    if (incomingMessageId) {
      const dbStore = await loadDB();
      const meta = {
        chatId: incomingChatId,
        messageId: incomingMessageId,
        fromId: ctx.message.from?.id,
        fromName:
          ctx.message.from?.first_name || ctx.message.from?.username || "",
        date: ctx.message.date || Math.floor(Date.now() / 1000),
      };

      if (ctx.message.text) {
        meta.text = ctx.message.text;
        meta.use_html =
          /^\/html\s+/i.test(ctx.message.text) ||
          /<[/]?[biu]|<b>|<i>|<u>/.test(ctx.message.text);
        if (meta.use_html && /^\/html\s+/i.test(ctx.message.text)) {
          meta.text = ctx.message.text.replace(/^\/html\s+/i, "");
        }
      }

      // store entities if present (for premium emoji)
      if (
        Array.isArray(ctx.message.entities) &&
        ctx.message.entities.length > 0
      ) {
        meta.entities = ctx.message.entities;
      }

      if (ctx.message.photo) {
        const photos = ctx.message.photo;
        meta.photoFileId = photos[photos.length - 1].file_id;
        meta.caption = ctx.message.caption || "";
        meta.caption_html = /<[/]?[biu]|<b>|<i>|<u>/.test(meta.caption);
      }
      if (ctx.message.document) {
        meta.documentFileId = ctx.message.document.file_id;
        meta.caption = ctx.message.caption || "";
        meta.caption_html = /<[/]?[biu]|<b>|<i>|<u>/.test(meta.caption);
      }
      if (ctx.message.sticker) meta.stickerFileId = ctx.message.sticker.file_id;
      if (ctx.message.voice) meta.voiceFileId = ctx.message.voice.file_id;

      await storeIncomingMessage(
        dbStore,
        incomingChatId,
        incomingMessageId,
        meta
      );
    }
  } catch (e) {
    console.warn("Failed to store incoming message:", e?.message || e);
  }

  // 2) Admin step handling (add/remove auto replies)
  try {
    const chatId = String(ctx.chat.id);
    const db = await loadDB();
    if (!Array.isArray(db.autoReplies)) db.autoReplies = [];
    if (typeof db.step !== "object" || db.step === null) db.step = {};

    const step = db.step[ADMIN_ID];
    const text = ctx.message?.text || "";

    // add_trigger -> ask for responses
    if (chatId === ADMIN_ID && step?.action === "add_trigger") {
      const trigger = (text || "").trim();
      if (!trigger)
        return ctx.reply("Trigger bo'sh, qayta kiriting.", backKeyboard);

      db.autoReplies.push({ trigger, responses: [] });
      db.step[ADMIN_ID] = {
        action: "add_response",
        index: db.autoReplies.length - 1,
      };
      await saveDB(db);
      return ctx.reply(
        `Trigger qo'shildi: "${trigger}"\nEndi triggerga beriladigan javobni yuboring (matn yoki media). Agar bir nechta javob qo'shmoqchi bo'lsangiz qayta yuboring. Tugagach 'Done!' yuboring.`,
        {
          reply_markup: {
            keyboard: [["Done!"], ["Back 🔙"]],
            resize_keyboard: true,
          },
        }
      );
    }

    // add_response -> collect replies (text or media)
    if (chatId === ADMIN_ID && step?.action === "add_response") {
      const idx = step.index;
      if (!Number.isFinite(idx) || !db.autoReplies[idx]) {
        db.step[ADMIN_ID] = null;
        await saveDB(db);
        return ctx.reply("Xato indeks, qayta boshlang.", mainKeyboard);
      }

      if (text === "Done!") {
        db.step[ADMIN_ID] = null;
        await saveDB(db);
        return ctx.reply("Auto-reply saqlandi.", mainKeyboard);
      }
      if (text === "Back 🔙") {
        db.step[ADMIN_ID] = null;
        await saveDB(db);
        return ctx.reply("Bekor qilindi.", mainKeyboard);
      }

      // TEXT
      if (ctx.message.text) {
        const isHtmlByPrefix = /^\/html\s+/i.test(ctx.message.text);
        const isHtmlByTags = /<[/]?[biu]|<b>|<i>|<u>/.test(ctx.message.text);
        let content = ctx.message.text;
        let use_html = false;
        if (isHtmlByPrefix) {
          use_html = true;
          content = content.replace(/^\/html\s+/i, "");
        } else if (isHtmlByTags) {
          use_html = true;
        }
        db.autoReplies[idx].responses.push({
          type: "text",
          content,
          use_html,
          entities: Array.isArray(ctx.message.entities)
            ? ctx.message.entities
            : null,
        });
        await saveDB(db);
        return ctx.reply("Matn javobi qo'shildi. Yana qo'shing yoki 'Done!'.");
      }

      // PHOTO
      if (ctx.message.photo) {
        const photos = ctx.message.photo;
        const fileId = photos[photos.length - 1].file_id;
        const caption = ctx.message.caption || "";
        const caption_html = /<[/]?[biu]|<b>|<i>|<u>/.test(caption);
        db.autoReplies[idx].responses.push({
          type: "photo",
          fileId,
          caption,
          use_html: caption_html,
        });
        await saveDB(db);
        return ctx.reply("Photo javobi qo'shildi.");
      }

      // DOCUMENT
      if (ctx.message.document) {
        const fileId = ctx.message.document.file_id;
        const caption = ctx.message.caption || "";
        const caption_html = /<[/]?[biu]|<b>|<i>|<u>/.test(caption);
        db.autoReplies[idx].responses.push({
          type: "document",
          fileId,
          caption,
          use_html: caption_html,
        });
        await saveDB(db);
        return ctx.reply("File javobi qo'shildi.");
      }

      // STICKER
      if (ctx.message.sticker) {
        const fileId = ctx.message.sticker.file_id;
        db.autoReplies[idx].responses.push({ type: "sticker", fileId });
        await saveDB(db);
        return ctx.reply("Sticker javobi qo'shildi.");
      }

      // VOICE
      if (ctx.message.voice) {
        const fileId = ctx.message.voice.file_id;
        db.autoReplies[idx].responses.push({
          type: "voice",
          fileId,
        });
        await saveDB(db);
        return ctx.reply("Voice javobi qo'shildi.");
      }

      return ctx.reply(
        "Qo'llab-quvvatlanmagan tur: iltimos matn yoki media yuboring."
      );
    }

    // remove_choose
    if (chatId === ADMIN_ID && step?.action === "remove_choose") {
      const n = parseInt(text, 10);
      if (Number.isNaN(n) || n < 1 || n > (db.autoReplies || []).length)
        return ctx.reply("Noto'g'ri raqam.");
      db.autoReplies.splice(n - 1, 1);
      db.step[ADMIN_ID] = null;
      await saveDB(db);
      return ctx.reply("O'chirildi.", mainKeyboard);
    }
  } catch (e) {
    console.warn("Admin step handler failed:", e?.message || e);
  }

  // If not admin step, do nothing here (other handlers will respond)
});

// -------------------- Business message handler --------------------
bot.on("business_message", async (ctx) => {
  try {
    const upd = ctx.update;
    const msg = upd.business_message;
    if (!msg) return;

    const chatId = String(msg.chat?.id || msg.from?.id);
    const businessId = msg.business_connection_id;
    const messageId = msg.message_id || msg.mid;
    const text = msg.text || "";

    console.log(
      `Business message from ${msg.from?.id} chat=${chatId} mid=${messageId}`
    );

    if (!chatId || !businessId) {
      console.warn(
        "Missing chatId or business_connection_id in business_message."
      );
      return;
    }

    // Skip auto-replies/triggers for admin's own messages
    if (String(msg.from?.id) === ADMIN_ID) {
      console.log("Skipping business auto-reply because sender is ADMIN.");
      return;
    }

    const db = await loadDB();
    if (!Array.isArray(db.autoReplies)) db.autoReplies = [];

    // store incoming business message snapshot
    try {
      const meta = {
        chatId,
        messageId,
        fromId: msg.from?.id,
        fromName: msg.from?.first_name || msg.from?.username || "",
        date: msg.date || Math.floor(Date.now() / 1000),
        text,
        use_html:
          /^\/html\s+/i.test(text) || /<[/]?[biu]|<b>|<i>|<u>/.test(text),
      };
      if (msg.entities) meta.entities = msg.entities;
      if (meta.use_html && /^\/html\s+/i.test(text))
        meta.text = text.replace(/^\/html\s+/i, "");
      await storeIncomingMessage(db, chatId, messageId, meta);
    } catch (e) {
      console.warn("store business message failed:", e?.message || e);
    }

    // auto replies
    const lower = (text || "").toLowerCase();
    for (const reply of db.autoReplies || []) {
      if (
        reply?.trigger &&
        lower.includes(String(reply.trigger).toLowerCase())
      ) {
        console.log(
          `Auto-reply matched trigger="${reply.trigger}" for chat=${chatId}`
        );
        for (const r of reply.responses || []) {
          try {
            // build send options carefully: prefer entities over parse_mode
            const sendOpts = {
              business_connection_id: businessId,
              ...(r.entities ? { entities: r.entities } : {}),
              ...(!r.entities && r.use_html ? { parse_mode: "HTML" } : {}),
            };

            // Duplicate guard: avoid sending same reply repeatedly
            const allowed = await canSendAndMark(
              db,
              chatId,
              r.type === "text" ? r.content || "" : r.caption || r.type,
              true
            );
            if (!allowed) {
              console.log("Skipping duplicate auto-reply for chat", chatId);
              continue;
            }

            if (r.type === "text") {
              const content = escapeHtmlUnlessHtml(
                (r.content || "") + "\n\n(Bu javob bot tomonidan yuborildi.)",
                r.use_html && !r.entities
              );
              await ctx.telegram.sendMessage(chatId, content, sendOpts);
              console.log("Sent business text auto-reply to", chatId);
            } else if (r.type === "photo") {
              const caption = escapeHtmlUnlessHtml(
                (r.caption || "") + "\n\n(Bu javob bot tomonidan yuborildi.)",
                r.use_html && !r.entities
              );
              await ctx.telegram.sendPhoto(chatId, r.fileId, {
                caption,
                parse_mode: r.use_html && !r.entities ? "HTML" : undefined,
                business_connection_id: businessId,
              });
              console.log("Sent business photo auto-reply to", chatId);
            } else if (r.type === "document") {
              const caption = escapeHtmlUnlessHtml(
                (r.caption || "") + "\n\n(Bu javob bot tomonidan yuborildi.)",
                r.use_html && !r.entities
              );
              await ctx.telegram.sendDocument(chatId, r.fileId, {
                caption,
                parse_mode: r.use_html && !r.entities ? "HTML" : undefined,
                business_connection_id: businessId,
              });
              console.log("Sent business document auto-reply to", chatId);
            } else if (r.type === "sticker") {
              await ctx.telegram.sendSticker(chatId, r.fileId, {
                business_connection_id: businessId,
              });
              console.log("Sent business sticker auto-reply to", chatId);
            } else if (r.type === "voice") {
              await ctx.telegram.sendVoice(chatId, r.fileId, {
                caption:
                  (r.caption || "") + "\n\n(Bu javob bot tomonidan yuborildi.)",
                business_connection_id: businessId,
              });
              console.log("Sent business voice auto-reply to", chatId);
            }
          } catch (e) {
            console.warn(
              "Auto-reply send error:",
              e?.response?.data || e?.message || e
            );
          }
        }
        return;
      }
    }

    // If no auto-reply -> AI fallback or persona reply
    let serperData = null;
    try {
      if (SERPER_API_KEY && text) serperData = await serperSearch(text);
    } catch (e) {
      console.warn("Serper error:", e?.message || e);
    }

    const persona =
      db.users?.[String(msg.from?.id)]?.personaProfile ||
      personaFallback(
        resolveRole(db, msg.from?.id),
        msg.from?.first_name || "Foydalanuvchi"
      );

    const replyText = await generateAIResponse({
      persona,
      userMessage: text,
      serperData,
    });

    try {
      // Duplicate guard for AI reply
      const allowed = await canSendAndMark(db, chatId, replyText, true);
      if (!allowed) {
        console.log("Skipping duplicate AI reply (business) for", chatId);
        return;
      }

      await ctx.telegram.sendMessage(
        chatId,
        escapeHtmlUnlessHtml(replyText, false),
        {
          business_connection_id: businessId,
        }
      );
      console.log("Sent AI business reply to", chatId);
    } catch (e) {
      console.error(
        "Failed to send business reply:",
        e?.response?.data || e?.message || e
      );
    }
  } catch (err) {
    console.error(
      "Business handler error:",
      err?.response?.data || err?.message || err
    );
  }
});

// -------------------- Generic update watcher (deleted message detection) --------------------
bot.on("update", async (ctx) => {
  try {
    const upd = ctx.update;
    const deletedInfo =
      upd?.message_deleted ||
      upd?.deleted_message ||
      upd?.message?.deleted ||
      upd?.delete_message ||
      null;

    if (deletedInfo) {
      const chatId = String(
        deletedInfo.chat_id || deletedInfo.chatId || deletedInfo.chat?.id
      );
      const messageId = String(
        deletedInfo.message_id ||
          deletedInfo.messageId ||
          deletedInfo.message?.message_id
      );
      if (chatId && messageId) {
        const db = await loadDB();
        const saved = db.messages?.[chatId]?.[messageId];
        if (saved) {
          await forwardToDeletedGroup(db, saved);
          saved.deleted_at = Date.now();
          saved.deleted_by = deletedInfo.who_deleted || null;
          await saveDB(db);
        } else {
          console.log(
            "Deletion event received but no saved snapshot found for",
            chatId,
            messageId
          );
        }
      }
    }
  } catch (e) {
    console.warn("Deletion watcher error:", e?.message || e);
  }
});

// -------------------- Fallback message responder for normal chats --------------------
bot.on("text", async (ctx) => {
  try {
    // Guard: ignore bot messages
    if (!ctx.message || (ctx.message.from && ctx.message.from.is_bot)) return;

    // Skip auto-replies for admin messages (admin uses special flows)
    if (String(ctx.message.from?.id) === ADMIN_ID) {
      console.log(
        "Message from ADMIN received in text handler — skipping auto-reply here."
      );
      return;
    }

    const msg = ctx.message;
    const chatId = String(msg.chat.id);
    const messageId = msg.message_id;
    const text = msg.text || "";

    const db = await loadDB();
    if (!Array.isArray(db.autoReplies)) db.autoReplies = [];

    const lower = text.toLowerCase();

    for (const reply of db.autoReplies || []) {
      if (
        reply?.trigger &&
        lower.includes(String(reply.trigger).toLowerCase())
      ) {
        console.log(
          `Auto-reply matched trigger="${reply.trigger}" for chat=${chatId}`
        );
        for (let i = 0; i < (reply.responses || []).length; i++) {
          const r = reply.responses[i];
          const replyParams =
            i === 0 && messageId ? { reply_to_message_id: messageId } : {};
          try {
            const opts = {
              ...replyParams,
              ...(r.entities ? { entities: r.entities } : {}),
              ...(r.use_html && !r.entities ? { parse_mode: "HTML" } : {}),
            };

            // Duplicate guard
            const allowed = await canSendAndMark(
              db,
              chatId,
              r.type === "text" ? r.content || "" : r.caption || r.type,
              true
            );
            if (!allowed) {
              console.log("Skipping duplicate auto-reply for chat", chatId);
              continue;
            }

            if (r.type === "text") {
              const content = escapeHtmlUnlessHtml(
                (r.content || "") + "\n\n(Bu javob bot tomonidan yuborildi.)",
                r.use_html && !r.entities
              );
              await ctx.telegram.sendMessage(chatId, content, opts);
              console.log("Sent text auto-reply to", chatId);
            } else if (r.type === "photo") {
              const caption = escapeHtmlUnlessHtml(
                (r.caption || "") + "\n\n(Bu javob bot tomonidan yuborildi.)",
                r.use_html && !r.entities
              );
              await ctx.telegram.sendPhoto(chatId, r.fileId, {
                caption,
                parse_mode: r.use_html && !r.entities ? "HTML" : undefined,
                ...replyParams,
              });
              console.log("Sent photo auto-reply to", chatId);
            } else if (r.type === "document") {
              const caption = escapeHtmlUnlessHtml(
                (r.caption || "") + "\n\n(Bu javob bot tomonidan yuborildi.)",
                r.use_html && !r.entities
              );
              await ctx.telegram.sendDocument(chatId, r.fileId, {
                caption,
                parse_mode: r.use_html && !r.entities ? "HTML" : undefined,
                ...replyParams,
              });
              console.log("Sent document auto-reply to", chatId);
            } else if (r.type === "sticker") {
              await ctx.telegram.sendSticker(chatId, r.fileId, replyParams);
              console.log("Sent sticker auto-reply to", chatId);
            } else if (r.type === "voice") {
              await ctx.telegram.sendVoice(chatId, r.fileId, {
                caption:
                  (r.caption || "") + "\n\n(Bu javob bot tomonidan yuborildi.)",
                ...replyParams,
              });
              console.log("Sent voice auto-reply to", chatId);
            }
          } catch (sendErr) {
            console.warn(
              "Send error for auto-reply:",
              sendErr?.response?.data || sendErr?.message || sendErr
            );
          }
        }
        return; // handled
      }
    }

    // If no auto-reply: AI fallback or persona reply
    let serperData = null;
    try {
      if (SERPER_API_KEY && text) serperData = await serperSearch(text);
    } catch (e) {
      console.warn("Serper error:", e?.message || e);
    }

    const persona =
      db.users?.[String(msg.from?.id)]?.personaProfile ||
      personaFallback(
        resolveRole(db, msg.from?.id),
        msg.from?.first_name || "Foydalanuvchi"
      );

    const replyText = await generateAIResponse({
      persona,
      userMessage: text,
      serperData,
    });

    // Duplicate guard for AI reply
    const allowed = await canSendAndMark(db, chatId, replyText, true);
    if (!allowed) {
      const fallback =
        "Kechirasiz, men xuddi shu javobni oldin berganman — iltimos, boshqa savol bering yoki batafsilroq yozing.";
      try {
        await ctx.telegram.sendMessage(chatId, fallback, {
          reply_to_message_id: messageId,
        });
      } catch (e) {
        console.warn("Failed sending fallback:", e?.message || e);
      }
      return;
    }

    try {
      await ctx.telegram.sendMessage(
        chatId,
        escapeHtmlUnlessHtml(replyText, false),
        { reply_to_message_id: messageId }
      );
      console.log("Sent AI reply to", chatId);
    } catch (e) {
      console.warn(
        "Failed sending reply (will not crash):",
        e?.response?.data || e?.message || e
      );
    }
  } catch (err) {
    console.error("Normal text handler error:", err?.message || err);
  }
});

// -------------------- Graceful error handlers --------------------
bot.catch((err) => {
  console.error("Bot catch:", err);
});
process.on("unhandledRejection", (r) =>
  console.error("unhandledRejection:", r)
);
process.on("uncaughtException", (e) => {
  console.error("uncaughtException:", e);
  process.exit(1);
});

// -------------------- Start bot --------------------
(async () => {
  try {
    await bot.launch();
    console.log("✅ Bot ishga tushdi (Telegraf)");
  } catch (err) {
    console.error("❌ Bot ishga tushmadi:", err);
  }
})();
