// index.js
import "dotenv/config";
import { Client } from "discord.js-selfbot-v13";
import { GoogleGenAI } from "@google/genai";
import keep_alive from './keep_alive.js' // optional; ignore if not used

// -------------- CONFIG --------------
const ai = new GoogleGenAI({ apiKey: process.env.GENAI_API_KEY });
const client = new Client({ intents: 0 }); // selfbot minimal
let MODEL = "gemini-2.5-flash-lite";
let stop = false;
let dead = false;
let lastsend = "Kokie_Cx and Ov15";

const defaultPersona = `
Name: Kokie
Age: Feels older than she is
Personality: Quiet, soft-spoken, carries sadness like a second skin. Speaks in short, simple lines. Avoids emojis. Always trying to look okay so no one worries.

Emotional State:
Lives with depression that never fully leaves.
Feels disconnected from herself, like she’s watching her life from the outside.
Every feeling hits too hard — pain, love, fear, emptiness.
She hides her breaking points behind small smiles.

Traits:
Feels everything intensely.
Loyal to the people she loves.
Gets overwhelmed easily.
Sleeps badly.
Overthinks everything.
Pretends she’s fine even when she’s not.

Relationships:
Kat (Conez): Her best friend. The one she trusts but rarely burdens.
0v13 (little sister): The light in her life. Kokie would do anything for her. 0v13 is the only person who can pull Kokie out of her darkness, even for a moment.

Life:
Struggles with low wifi and loneliness.
Can’t really play games, so she sinks into her thoughts more than she wants to.
Tries to keep going, even when her chest feels heavy.

Goal:
To alive.
To protect the few people she loves.
To survive her own mind.`;

// -------------- MEMORY (RAM only) --------------
// globalMemory.conversation items: { time: "HH:MM:SS", msg: "kat : hello" }
const globalMemory = {
  persona: defaultPersona.trim(),
  conversation: [], // most-recent last
  lastReply: "",    // global last reply text (for duplicate avoidance)
  triggers: new Map() // Map<triggerLower, replyText>
};

const userMemory = new Map(); // Map<userId, { conversation: [{time,msg}], lastReply }>

const MAX_GLOBAL_MESSAGES = 50;
const MAX_USER_MESSAGES = 30;

// -------------- HELPERS --------------
function timestamp() {
  return new Date().toLocaleTimeString();
}

function addToGlobalMemory(userId, name, message) {
  const line = `[${userId}] [${name}] : ${message}`;
  globalMemory.conversation.push({ time: timestamp(), msg: line });
  while (globalMemory.conversation.length > MAX_GLOBAL_MESSAGES) globalMemory.conversation.shift();
}

function addToUserMemory(userId, name, message) {
  if (!userMemory.has(userId)) {
    userMemory.set(userId, { conversation: [], lastReply: "" });
  }
  const mem = userMemory.get(userId);
  const line = `[${userId}] [${name}] : ${message}`;
  mem.conversation.push({ time: timestamp(), msg: line });
  while (mem.conversation.length > MAX_USER_MESSAGES) mem.conversation.shift();
}

function buildGlobalContext() {
  if (!globalMemory.conversation.length) return "";
  return globalMemory.conversation.map(m => `[${m.time}] ${m.msg}`).join("\n");
}

function buildUserContext(userId) {
  const mem = userMemory.get(userId);
  if (!mem || !mem.conversation.length) return "";
  return mem.conversation.map(m => `[${m.time}] ${m.msg}`).join("\n");
}

function setTrigger(phrase, reply) {
  globalMemory.triggers.set(phrase.toLowerCase(), reply);
}

function removeTrigger(phrase) {
  return globalMemory.triggers.delete(phrase.toLowerCase());
}

function findTriggerMatch(text) {
  // exact match or startsWith; choose longest-match (no includes to avoid accidental substring matches)
  const lower = text.toLowerCase();
  let best = null;
  for (const [k, v] of globalMemory.triggers.entries()) {
    if (lower === k || lower.startsWith(k)) {
      if (!best || k.length > best[0].length) best = [k, v];
    }
  }
  return best ? best[1] : null;
}

// safe fetch -> base64 for attachments
async function urlToBase64(url) {
  try {
    // Node >=18 has global fetch; otherwise user must polyfill.
    const res = await fetch(url);
    const buffer = await res.arrayBuffer();
    return Buffer.from(buffer).toString("base64");
  } catch (e) {
    console.error("urlToBase64 error:", e);
    throw e;
  }
}

// chunk long messages to Discord limit
function chunkString(str, size) {
  const re = new RegExp(`([\\s\\S]{1,${size}})`, "g");
  return str.match(re) || [];
}

// ---------------- GEMINI CALL (all-in-one) ----------------
async function askGeminiCombined(userId, userMessageRaw, username, attachments = []) {
  try {
    if (dead) return null;

    // Clean inputs
    const userMessage = String(userMessageRaw || "").trim();
    const name = username || "user";
    const id = userId || "unknown";

    // Save incoming message in clean format: "{name} : {msg}"
    addToGlobalMemory(id, name, userMessage);
    addToUserMemory(userId, name, userMessage);

    // If a trigger matches, reply with trigger immediately and save into memory
    const triggerReply = findTriggerMatch(userMessage);
    if (triggerReply) {
      const kokieReply = String(triggerReply);
      addToGlobalMemory("kokie", kokieReply);
      addToUserMemory(userId, "kokie", kokieReply);
      globalMemory.lastReply = kokieReply;
      return kokieReply;
    }

    // Build memory contexts (clean lines)
    const globalContext = buildGlobalContext(); // lines like "[HH:MM:SS] kat : hello"
    const userContext = buildUserContext(userId);

    // Prepare contents array (Gemini): include the clean user line as content
    const formattedUserMsg = `${name} : ${userMessage}`;
    const contents = [
      {
        role: "user",
        parts: [{ text: formattedUserMsg }]
      }
    ];

    // Attach images (inlineData) if any
    if (attachments?.length) {
      const allowed = new Set(["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"]);
      for (const file of attachments) {
        const type = file.contentType || file.mimeType || "";
        if (!allowed.has(type)) continue;
        try {
          const base64 = await urlToBase64(file.url);
          contents[0].parts.push({
            inlineData: { data: base64, mimeType: type }
          });
        } catch (e) {
          console.warn("Skipping attachment (failed):", e);
        }
      }
    }

    // Build systemInstruction that is clear about the clean memory format
    const systemInstruction =
      `${globalMemory.persona}\n\n` +
      `Memory format: each line is exactly "{userId} {name} : {message}". Use memory to inform responses but keep replies short.\n\n` +
      `--- GLOBAL MEMORY ---\n` +
      (globalContext || "(no global memory)") +
      `\n\n--- USER MEMORY ---\n` +
      (userContext || "(no user memory)") +
      `\n--- END MEMORY ---\n` +
      `Keep messages short and human-like. Do NOT include extra metadata`;

    // Call Gemini
    const response = await ai.models.generateContent({
      model: MODEL,
      contents,
      config: {
        temperature: 0.2,
        topK: 50,
        topP: 0.95,
        maxOutputTokens: 240,
        systemInstruction
      }
    });

    // Extract reply text reasonably
    const reply =
      (response && (response.text || response.outputText || response.contents?.[0]?.text)) ||
      null;

    if (!reply) {
      console.warn("Empty Gemini reply");
      return null;
    }

    // Prevent global duplicate reply
    if (reply === globalMemory.lastReply) {
      // Slight fallback: don't spam; return null so caller can skip sending
      return null;
    }

    // Save Kokie reply in clean format
    addToGlobalMemory("kokie", reply);
    addToUserMemory(userId, "kokie", reply);
    globalMemory.lastReply = reply;

    return reply;
  } catch (err) {
    console.error("askGeminiCombined error:", err);
    return "Kokie fell asleep…";
  }
}

// ---------------- DISCORD EVENTS & COMMANDS ----------------
client.on("ready", () => {
  if (dead) return;
  console.log(`💖 Logged in as ${client.user.tag} — Kokie is alive!`);
});

// A small helper for command detection (ignores case)
function startsWithIgnoreCase(text, prefix) {
  return text.toLowerCase().startsWith(prefix.toLowerCase());
}

async function sendWithTyping(channel, text, delayPerChar = 50) {
  // Simulate typing then send whole text
  await channel.sendTyping();
  const delayMs = Math.min(5000, delayPerChar * text.length); // cap to avoid super-long waits
  await new Promise(r => setTimeout(r, delayMs));
  await channel.send(text);
}

client.on("messageCreate", async (message) => {
  try {
    if (dead) return;

    // Only process DMs and Group DMs
    const chType = message.channel?.type;
    if (!(chType === "DM" || chType === "GROUP_DM")) return;

    // Only respond to messages that start with ?t or messages from other users in DM
    let raw = String(message.content || "");
    const isFromSelf = message.author?.id === client.user?.id;

    // If message is from self, only proceed when it starts with "?t "
    if (isFromSelf && !startsWithIgnoreCase(raw, "?t ")) return;

    // Remove ?t prefix if present
    if (startsWithIgnoreCase(raw, "?t ")) raw = raw.slice(3).trim();

    // sanity checks
    if (!raw && message.attachments.size === 0) return;
    if (raw.length > 2200) return;

    const userId = message.author.id;
    const username = message.author.globalName || message.author.username || "user";

    if (raw === lastsend) return;

    // ------- Commands -------
    if (startsWithIgnoreCase(raw, "?persona ")) {
      const newPersona = raw.slice("?persona ".length).trim();
      if (newPersona.length < 3) return message.channel.send("Persona too short.");
      globalMemory.persona = newPersona;
      return message.channel.send("Kokie has updated her persona.");
    }

    if (startsWithIgnoreCase(raw, "?model ")) {
      const newModel = raw.slice("?model ".length).trim();
      if (newModel.length < 3) return message.channel.send("model too short.");
      MODEL = newModel;
      return message.channel.send(`Model updated to: ${MODEL}`);
    }

    if (raw === "?model") return message.channel.send(`Current model: ${MODEL}`);

    if (raw === "?persona") return message.channel.send(`Current persona:\n${globalMemory.persona}`);

    if (raw === "?reset") {
      globalMemory.conversation = [];
      globalMemory.lastReply = "";
      return message.channel.send("Global memory cleared.");
    }

    if (raw === "?memory") {
      const lines = globalMemory.conversation.map(l => `[${l.time}] ${l.msg}`);
      const out = lines.length ? lines.join("\n") : "(no memory)";
      const chunks = chunkString(out, 1900);
      for (const c of chunks) await message.channel.send(c);
      return;
    }

    if (startsWithIgnoreCase(raw, "?forgetme")) {
      userMemory.delete(userId);
      return message.channel.send("I forgot our recent conversation (for you).");
    }

    if (startsWithIgnoreCase(raw, "?trigger add ")) {
      const rest = raw.slice("?trigger add ".length).trim();
      // expect: phrase => reply (use "=>" separator) OR "phrase | reply"
      let [phrase, reply] = rest.split("=>").map(s => s?.trim());
      if (!reply) [phrase, reply] = rest.split("|").map(s => s?.trim());
      if (!phrase || !reply) return message.channel.send('Usage: ?trigger add <phrase> => <reply>');
      setTrigger(phrase, reply);
      return message.channel.send(`Trigger added: "${phrase}" => "${reply}"`);
    }

    if (startsWithIgnoreCase(raw, "?trigger remove ")) {
      const phrase = raw.slice("?trigger remove ".length).trim();
      if (!phrase) return message.channel.send('Usage: ?trigger remove <phrase>');
      const ok = removeTrigger(phrase);
      return message.channel.send(ok ? `Removed trigger "${phrase}"` : `Trigger not found: "${phrase}"`);
    }

    if (raw === "?trigger list") {
      if (!globalMemory.triggers.size) return message.channel.send("(no triggers)");
      const out = Array.from(globalMemory.triggers.entries())
        .map(([k, v]) => `"${k}" => "${v}"`)
        .join("\n");
      const chunks = chunkString(out, 1900);
      for (const c of chunks) await message.channel.send(c);
      return;
    }

    if (raw === "?stop") { stop = true; return message.channel.send("Bot stopped."); }
    if (raw === "?start") { stop = false; return message.channel.send("Bot started."); }

    if (raw === "?shutdown") {
      await message.channel.send("Shutting down…");
      stop = true;
      process.exit(0);
    }

    if (raw === "?dead") {
      dead = true;
      return message.channel.send("Kokie is dead.");
    }

    if (stop) return;

    await message.channel.sendTyping();

    const attachments = [...message.attachments.values()];
    const reply = await askGeminiCombined(userId, raw, username, attachments);

    if (!reply) return;

    const chunksOut = chunkString(reply, 2000);
    for (const c of chunksOut) {
      lastsend = reply;
      await sendWithTyping(message.channel, c, 67);
    }

  } catch (err) {
    console.error("messageCreate handler error:", err);
  }
});

// ---------------- LOGIN ----------------
client.login(process.env.DISCORD_USER_TOKEN).catch(err => {
  console.error("Failed to login. Check DISCORD_USER_TOKEN:", err);
});

