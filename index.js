// index.fixed.js — patched version with defensive DB normalization,
// stricter step handling, and safer save/load semantics.

import { Telegraf } from "telegraf";
import axios from "axios";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import "dotenv/config";
import express from "express";

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const ADMIN_ID = (process.env.ADMIN_ID || "").toString();
const DATA_DIR = path.resolve(process.cwd(), "data");
const DB_FILE = path.resolve(DATA_DIR, "db.json");

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
const ENABLE_SELF_PING = process.env.ENABLE_SELF_PING === "true";
const SELF_PING_URL = process.env.SELF_PING_URL || "";
const SELF_PING_INTERVAL_MS = parseInt(
  process.env.SELF_PING_INTERVAL_MS || "240000",
  10
);

// Basic env check
if (!BOT_TOKEN || !ADMIN_ID) {
  console.error(
    "❌ BOT_TOKEN va ADMIN_ID .env da belgilanmagan. Iltimos to'ldiring."
  );
  process.exit(1);
}

console.log("📦 index.js yuklandi");
console.log("AI_ENABLED =", AI_ENABLED);

const bot = new Telegraf(BOT_TOKEN);

// -------------------- DB helpers --------------------
function normalizeDBShape(parsed) {
  // Ensure the DB always has the expected structure and types
  const db = {};
  db.users =
    typeof parsed.users === "object" && parsed.users !== null
      ? parsed.users
      : {};
  db.autoReplies = Array.isArray(parsed.autoReplies) ? parsed.autoReplies : [];
  db.conversations =
    typeof parsed.conversations === "object" && parsed.conversations !== null
      ? parsed.conversations
      : {};
  db.step =
    typeof parsed.step === "object" && parsed.step !== null ? parsed.step : {};
  db.messages =
    typeof parsed.messages === "object" && parsed.messages !== null
      ? parsed.messages
      : {};
  db.deletedLog = Array.isArray(parsed.deletedLog) ? parsed.deletedLog : [];
  return db;
}

async function ensureDataFile() {
  try {
    if (!fsSync.existsSync(DATA_DIR)) {
      await fs.mkdir(DATA_DIR, { recursive: true });
      console.log("Created data directory:", DATA_DIR);
    }
    if (!fsSync.existsSync(DB_FILE)) {
      const base = {
        users: {},
        autoReplies: [],
        conversations: {},
        step: {},
        messages: {},
        deletedLog: [],
      };
      await fs.writeFile(DB_FILE, JSON.stringify(base, null, 2), "utf8");
      console.log("Created DB file at:", DB_FILE);
    }
  } catch (e) {
    console.error("Failed to ensure data file:", e?.message || e);
    process.exit(1);
  }
}

async function loadDB() {
  try {
    const raw = await fs.readFile(DB_FILE, "utf8");
    let parsed = {};
    try {
      parsed = raw ? JSON.parse(raw) : {};
    } catch (e) {
      console.warn(
        "loadDB: JSON parse failed — will reinitialize DB.",
        e?.message || e
      );
      parsed = {};
    }
    const normalized = normalizeDBShape(parsed);
    return normalized;
  } catch (err) {
    console.warn(
      "loadDB: fayl o'qib bo'lmadi, yangi DB qaytarilmoqda.",
      err?.message || err
    );
    return normalizeDBShape({});
  }
}

let writeInProgress = false;
let writeQueued = false;
async function saveDB(db) {
  // Normalize before saving to avoid accidental type regressions
  const toSave = normalizeDBShape(db || {});

  // simple write queue
  if (writeInProgress) {
    writeQueued = true;
    while (writeInProgress) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  writeInProgress = true;
  try {
    await fs.writeFile(DB_FILE, JSON.stringify(toSave, null, 2), "utf8");
  } finally {
    writeInProgress = false;
    if (writeQueued) {
      writeQueued = false;
    }
  }
}

// Defensive helper used before mutating step/conversations
function ensureMutableFields(db) {
  if (typeof db !== "object" || db === null) return normalizeDBShape({});
  if (typeof db.step !== "object" || db.step === null) db.step = {};
  if (typeof db.users !== "object" || db.users === null) db.users = {};
  if (!Array.isArray(db.autoReplies)) db.autoReplies = [];
  if (typeof db.conversations !== "object" || db.conversations === null)
    db.conversations = {};
  if (typeof db.messages !== "object" || db.messages === null) db.messages = {};
  if (!Array.isArray(db.deletedLog)) db.deletedLog = [];
  return db;
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
      // eslint-disable-next-line no-await-in-loop
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

// -------------------- Single update watcher (preview + delete detection) --------------------
bot.on("update", async (ctx, next) => {
  try {
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

    const upd = ctx.update;
    // Telegram does not always include a consistent delete shape; try multiple
    const deletedInfo =
      upd?.message?.delete_chat_photo ||
      upd?.edited_message?.delete_message ||
      upd?.edited_message?.deleted ||
      upd?.message_deleted ||
      upd?.deleted_message ||
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
    console.warn("Update watcher error:", e?.message || e);
  }
  return next();
});

// -------------------- Admin commands --------------------
bot.start(async (ctx) => {
  const chatId = String(ctx.chat.id);
  if (chatId !== ADMIN_ID) return ctx.reply("Bu bot faqat admin uchun.");
  const db = await loadDB();
  ensureMutableFields(db);
  await saveDB(db);
  ctx.reply("Assalomu alaykum, admin. Tanlang:", mainKeyboard);
});

bot.hears("Add auto reply ✉️", async (ctx) => {
  if (String(ctx.chat.id) !== ADMIN_ID) return;
  const db = await loadDB();
  ensureMutableFields(db);
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
  ensureMutableFields(db);
  if (!Array.isArray(db.autoReplies) || db.autoReplies.length === 0)
    return ctx.reply("Auto-reply ro'yxati bo'sh.", mainKeyboard);

  let list = "Auto-replylar:\n\n";
  db.autoReplies.forEach((r, i) => {
    list += `${i + 1}. ${r.trigger} (${(r.responses || []).length} javob)\n`;
  });

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
  ensureMutableFields(db);
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
  ensureMutableFields(db);
  // remove step for admin to avoid storing null or wrong types
  if (db.step && Object.prototype.hasOwnProperty.call(db.step, ADMIN_ID)) {
    delete db.step[ADMIN_ID];
  }
  await saveDB(db);
  return ctx.reply("Bosh menyu", mainKeyboard);
});

// -------------------- Main message handler (admin step + storage) --------------------
bot.on("message", async (ctx) => {
  try {
    const incomingChatId = String(ctx.chat.id);
    const incomingMessageId = ctx.message?.message_id || ctx.message?.messageId;
    if (incomingMessageId) {
      const dbStore = await loadDB();
      ensureMutableFields(dbStore);
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
          /<\/?[biu]|<b>|<i>|<u>/.test(ctx.message.text);
        if (meta.use_html && /^\/html\s+/i.test(ctx.message.text)) {
          meta.text = ctx.message.text.replace(/^\/html\s+/i, "");
        }
      }

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
        meta.caption_html = /<\/?[biu]|<b>|<i>|<u>/.test(meta.caption);
      }
      if (ctx.message.document) {
        meta.documentFileId = ctx.message.document.file_id;
        meta.caption = ctx.message.caption || "";
        meta.caption_html = /<\/?[biu]|<b>|<i>|<u>/.test(meta.caption);
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

  // 2) Admin step handling
  try {
    const chatId = String(ctx.chat.id);
    const db = await loadDB();
    ensureMutableFields(db);

    const step = db.step[ADMIN_ID];
    const text = ctx.message?.text || "";

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

    if (chatId === ADMIN_ID && step?.action === "add_response") {
      const idx = step.index;
      if (!Number.isFinite(idx) || !db.autoReplies[idx]) {
        // reset admin step safely
        if (db.step && Object.prototype.hasOwnProperty.call(db.step, ADMIN_ID))
          delete db.step[ADMIN_ID];
        await saveDB(db);
        return ctx.reply("Xato indeks, qayta boshlang.", mainKeyboard);
      }

      if (text === "Done!") {
        if (db.step && Object.prototype.hasOwnProperty.call(db.step, ADMIN_ID))
          delete db.step[ADMIN_ID];
        await saveDB(db);
        return ctx.reply("Auto-reply saqlandi.", mainKeyboard);
      }
      if (text === "Back 🔙") {
        if (db.step && Object.prototype.hasOwnProperty.call(db.step, ADMIN_ID))
          delete db.step[ADMIN_ID];
        await saveDB(db);
        return ctx.reply("Bekor qilindi.", mainKeyboard);
      }

      // TEXT
      if (ctx.message.text) {
        const isHtmlByPrefix = /^\/html\s+/i.test(ctx.message.text);
        const isHtmlByTags = /<\/?[biu]|<b>|<i>|<u>/.test(ctx.message.text);
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
        const caption_html = /<\/?[biu]|<b>|<i>|<u>/.test(caption);
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
        const caption_html = /<\/?[biu]|<b>|<i>|<u>/.test(caption);
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

    if (chatId === ADMIN_ID && step?.action === "remove_choose") {
      const n = parseInt(text, 10);
      const listLen = Array.isArray(db.autoReplies) ? db.autoReplies.length : 0;
      if (Number.isNaN(n) || n < 1 || n > listLen)
        return ctx.reply("Noto'g'ri raqam.");
      db.autoReplies.splice(n - 1, 1);
      if (db.step && Object.prototype.hasOwnProperty.call(db.step, ADMIN_ID))
        delete db.step[ADMIN_ID];
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

    if (String(msg.from?.id) === ADMIN_ID) {
      console.log("Skipping business auto-reply because sender is ADMIN.");
      return;
    }

    const db = await loadDB();
    ensureMutableFields(db);

    try {
      const meta = {
        chatId,
        messageId,
        fromId: msg.from?.id,
        fromName: msg.from?.first_name || msg.from?.username || "",
        date: msg.date || Math.floor(Date.now() / 1000),
        text,
        use_html:
          /^\/html\s+/i.test(text) || /<\/?[biu]|<b>|<i>|<u>/.test(text),
      };
      if (msg.entities) meta.entities = msg.entities;
      if (meta.use_html && /^\/html\s+/i.test(text))
        meta.text = text.replace(/^\/html\s+/i, "");
      await storeIncomingMessage(db, chatId, messageId, meta);
    } catch (e) {
      console.warn("store business message failed:", e?.message || e);
    }

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
            const sendOpts = {
              business_connection_id: businessId,
              ...(r.entities ? { entities: r.entities } : {}),
              ...(!r.entities && r.use_html ? { parse_mode: "HTML" } : {}),
            };

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
      const allowed = await canSendAndMark(db, chatId, replyText, true);
      if (!allowed) {
        console.log("Skipping duplicate AI reply (business) for", chatId);
        return;
      }

      await ctx.telegram.sendMessage(
        chatId,
        escapeHtmlUnlessHtml(replyText, false),
        { business_connection_id: businessId }
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

// -------------------- Fallback message responder for normal chats --------------------
bot.on("text", async (ctx) => {
  try {
    if (!ctx.message || (ctx.message.from && ctx.message.from.is_bot)) return;

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
    ensureMutableFields(db);

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
        return;
      }
    }

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

// -------------------- HTTP server (health + basic) --------------------
const app = express();
app.use(express.json());
app.get("/", (req, res) =>
  res.send("Bot ishga tushgan. /health ni ping qiling.")
);
app.get("/health", (req, res) => res.json({ ok: true, ts: Date.now() }));

const PORT = parseInt(process.env.PORT || "3000", 10);

(async () => {
  try {
    await ensureDataFile();

    await bot.launch({ dropPendingUpdates: true }).catch((e) => {
      console.error("bot.launch failed:", e?.message || e);
      throw e;
    });

    app.listen(PORT, () => {
      console.log(`✅ Bot ishga tushdi (Telegraf). HTTP server port ${PORT}`);
      console.log(`Health endpoint: http://localhost:${PORT}/health`);
    });

    if (ENABLE_SELF_PING && SELF_PING_URL) {
      console.log("Self-ping yoqildi. URL =", SELF_PING_URL);
      setInterval(async () => {
        try {
          await axios.get(SELF_PING_URL, { timeout: 8000 });
          console.log(`Self-ping ok -> ${SELF_PING_URL}`);
        } catch (e) {
          console.warn("Self-ping failed:", e?.message || e);
        }
      }, Math.max(60000, SELF_PING_INTERVAL_MS));
    } else if (ENABLE_SELF_PING) {
      console.warn(
        "ENABLE_SELF_PING true, ammo SELF_PING_URL aniqlanmagan. Self-ping ishlamaydi."
      );
    }

    const shutdown = async (sig) => {
      console.log(`📴 Received ${sig}, stopping bot...`);
      try {
        await bot.stop();
        console.log("Bot stopped.");
      } catch (e) {
        console.warn("Error stopping bot:", e?.message || e);
      } finally {
        process.exit(0);
      }
    };
    process.once("SIGINT", () => shutdown("SIGINT"));
    process.once("SIGTERM", () => shutdown("SIGTERM"));
  } catch (err) {
    console.error("❌ Bot ishga tushmadi:", err);
    process.exit(1);
  }
})();

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
