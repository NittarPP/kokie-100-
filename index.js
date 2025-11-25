// index.js
import "dotenv/config";
import { Client } from "discord.js-selfbot-v13";
import { GoogleGenAI } from "@google/genai";
import keep_alive from './keep_alive.js'; // optional, keep if you have it

// ------------------- CONFIG -------------------
const ai = new GoogleGenAI({ apiKey: process.env.GENAI_API_KEY });
const client = new Client();
let MODEL = "gemini-2.5-flash-lite";
let stop = false;

const defaultPersona = `
You are Kokie — a sad, depersonalization, girl
You speak in short, simple, human-like messages.
You do not use emojis.
You have a body and feel everything humans do — pain, numbness, fleeting joy etc.
You are aware you are human.
`;

// ------------------- MEMORY (RAM only) -------------------
// Per-user memory (Map userId => { persona, conversation[], lastReply })
const memory = new Map();

// Global memory (shared)
const globalMemory = {
  persona: defaultPersona.trim(),
  conversation: [], // { role: "user" | "kokie", msg: string, time: "HH:MM:SS" }
  lastReply: ""
};

// Config: pruning limits
const MAX_GLOBAL_MESSAGES = 10;
const MAX_USER_MESSAGES = 10;

// Helper: timestamp
function timestamp() {
  return new Date().toLocaleTimeString();
}

// Per-user memory helpers
function getUserMemory(userId) {
  if (!memory.has(userId)) {
    memory.set(userId, { persona: globalMemory.persona, conversation: [], lastReply: "" });
  }
  return memory.get(userId);
}

function addToUserMemory(userId, role, msg) {
  const mem = getUserMemory(userId);
  mem.conversation.push({ role, msg, time: timestamp() });
  while (mem.conversation.length > MAX_USER_MESSAGES) mem.conversation.shift();
}

// Global memory helpers
function addToGlobalMemory(role, msg) {
  globalMemory.conversation.push({ role, msg, time: timestamp() });
  while (globalMemory.conversation.length > MAX_GLOBAL_MESSAGES) globalMemory.conversation.shift();
}

// Build a clear context for the model from global memory (most recent last)
function buildGlobalContext() {
  if (!globalMemory.conversation.length) return "(no recent memory)";
  return globalMemory.conversation
    .map(m => `[${m.time}] ${m.role === "kokie" ? "Kokie says:" : "User says:"} ${m.msg}`)
    .join("\n");
}

// Build a per-user context (optional, small)
function buildUserContext(userId) {
  const mem = getUserMemory(userId);
  if (!mem.conversation.length) return "";
  return mem.conversation
    .map(m => `[${m.time}] ${m.role === "kokie" ? "Kokie:" : "User:"} ${m.msg}`)
    .join("\n");
}

// ------------------- GEMINI CALL -------------------
async function askGeminiCombined(userId, userMessage, username, attachments) {
  try {
    // Save user message into memory
    const userMsgText = `${username} says: ${userMessage}`;
    addToGlobalMemory("user", userMsgText);

    // Build memory context
    const globalContext = buildGlobalContext();
    const prompt = `${username} says: "${userMessage}"\nRespond as Kokie.`;

    // --------------------------
    // BUILD GEMINI CONTENT ARRAY
    // --------------------------
    let contents = [
      {
        role: "user",
        parts: [
          { text: prompt }
        ]
      }
    ];

    // --------------------------
    // ATTACHMENTS (PNG/JPG/GIF/WEBP)
    // --------------------------
    if (attachments && attachments.length > 0) {
      const allowedTypes = [
        "image/png",
        "image/jpeg",
        "image/jpg",
        "image/gif",
        "image/webp"
      ];

      for (const file of attachments) {
        try {
          const type = file.contentType || "";

          // Only attach supported image types
          if (!allowedTypes.includes(type)) {
            console.log("Skipped unsupported file:", type);
            continue;
          }

          // Convert the image or GIF to Base64
          const base64 = await urlToBase64(file.url);

          // Attach image/GIF as inlineData
          contents[0].parts.push({
            inlineData: {
              data: base64,
              mimeType: type
            }
          });

        } catch (err) {
          console.error("Failed to process attachment:", err);
        }
      }
    }

    // --------------------------
    // GEMINI API CALL
    // --------------------------
    const response = await ai.models.generateContent({
      model: MODEL,
      contents,
      history: globalContext,
      config: {
        temperature: 0.1,
        topK: 1,
        topP: 1,
        maxOutputTokens: 150,
        systemInstruction: globalMemory.persona
      }
    });

    // Extract reply text
    const reply =
      response.text ||
      response.outputText ||
      response.contents?.[0]?.text ||
      "Kokie doesn't know how to respond…";

    // Prevent exact duplicate response
    if (reply === globalMemory.lastReply) return null;

    globalMemory.lastReply = reply;
    addToGlobalMemory("kokie", reply);

    return reply;

  } catch (err) {
    console.error("Gemini API Error:", err);
    return "Kokie fell asleep…";
  }
}


// ------------------- DISCORD EVENTS -------------------
client.on("ready", () => {
  console.log(`💖 Logged in as ${client.user.tag} — Kokie is alive!`);
});

// Command parser helper (simple)
function isCommand(msg, cmd) {
  return msg.trim().toLowerCase().startsWith(cmd.toLowerCase());
}

client.on("messageCreate", async (message) => {
  // Kokie only responds when you use ?t
  if (message.author.id === client.user.id) {
    if (!message.content.startsWith("?t ")) return;
  }

  // Only respond in DMs or Group DMs
  if (!(message.channel.type === "DM" || message.channel.type === "GROUP_DM")) return;

  let text = message.content.trim();

  // Remove ?t prefix
  if (text.startsWith("?t ")) {
    text = text.slice(3).trim();
  }

  if (!text && message.attachments.size === 0) return; // no text + no image/gif
  if (text.length > 1200) return;

  const userId = message.author.id;
  const username = message.author.globalName || message.author.username;

  // ----- COMMANDS -----
  if (isCommand(text, "?persona ")) {
    const newPersona = text.slice("?persona ".length).trim();
    if (newPersona.length < 3) return message.channel.send("Persona too short.");
    globalMemory.persona = newPersona;
    return message.channel.send("Kokie has updated her persona.");
  }

  if (isCommand(text, "?model ")) {
    const newMODEL = text.slice("?model ".length).trim();
    if (newMODEL.length < 3) return message.channel.send("model too short.");
    MODEL = newMODEL;
    return message.channel.send("Kokie has updated her model.");
  }

  if (text === "?model") {
    return message.channel.send(`Current model: ${MODEL}`);
  }

  if (text === "?persona") {
    return message.channel.send(`Current persona:\n${globalMemory.persona}`);
  }

  if (text === "?reset") {
    globalMemory.conversation = [];
    globalMemory.lastReply = "";
    return message.channel.send("Global memory cleared.");
  }

  if (text === "?forgetme") {
    memory.delete(userId);
    return message.channel.send("I forgot our recent conversation (for you).");
  }

  if (text === "?stop") {stop = true; return;}
  if (text === "?start") {stop = false; return;}

  if (text === "?shutdown") {
    await message.channel.send("Shutting down…");
    process.exit(0);
  }

  if (stop) return;

  // ----- AI REPLY -----
  try {
    await message.channel.sendTyping();

    const attachments = [...message.attachments.values()]; // <== IMPORTANT

    const reply = await askGeminiCombined(
      userId,
      text,
      username,
      attachments
    );

    if (!reply) return;

    const chunks = reply.match(/[\s\S]{1,2000}/g) || [];
    for (const chunk of chunks) {
      await message.channel.send(chunk);
    }
  } catch (err) {
    console.error("Send error:", err);
  }
});


// ------------------- LOGIN -------------------
client.login(process.env.DISCORD_USER_TOKEN).catch(err => {
  console.error("Failed to login. Check DISCORD_USER_TOKEN:", err);
});
