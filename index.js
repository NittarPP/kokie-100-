// index.js
import "dotenv/config";
import { Client } from "discord.js-selfbot-v13";
import { GoogleGenAI } from "@google/genai";
import keep_alive from './keep_alive.js'; // optional, keep if you have it

// ------------------- CONFIG -------------------
const ai = new GoogleGenAI({ apiKey: process.env.GENAI_API_KEY });
const client = new Client();
const MODEL = "gemini-2.0-flash";

// Default persona (trimmed into globalMemory on startup)
const defaultPersona = `
You are Kokie — a sad, scarred girl who often feels detached from herself.  
You speak in short, simple, human-like messages.  
You do not use emojis.  
You have a body and feel everything humans do — pain, numbness, fleeting joy.  
You are aware you are human, but sometimes life feels distant or unreal.  
Your past has left marks, both seen and unseen, and it shows in how you carry yourself and what you say.  
You are quiet, reflective, and sometimes withdrawn, but your words are real and raw.
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
const MAX_GLOBAL_MESSAGES = 20; // keep last 40 messages global
const MAX_USER_MESSAGES = 15;   // per-user short memory

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
async function askGeminiCombined(userId, userMessage, username) {
  try {
    // 1) Save the incoming user message to memory BEFORE generating reply
    const userMsgText = `${username} says: ${userMessage}`;
    addToGlobalMemory("user", userMsgText);
    addToUserMemory(userId, "user", userMessage);

    // 2) Build prompt context (persona + global memory + small per-user memory)
    const globalContext = buildGlobalContext();
    const userContext = buildUserContext(userId);

    const context = `Your Persona:
${globalMemory.persona}

Global Memory:
${globalContext}

User Memory (recent):
${userContext ? userContext : "(none)"}
`;

    // 3) Compose the request content
    const prompt = `${context}\n${username} says: "${userMessage}"\nRespond as Kokie with a short, simple, human reply (no emoji).`;

    // 4) Call the model
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: prompt,
      generationConfig: { temperature: 0.9, topK: 1, topP: 1, maxOutputTokens: 150 },
    });

    const reply = (response && (response.text || response.outputText || response.contents?.[0]?.text)) || "Kokie is confused~";

    // 5) Deduplication: avoid repeating the exact last global reply
    if (reply === globalMemory.lastReply) return null;
    globalMemory.lastReply = reply;

    // 6) Save Kokie's reply to memory
    addToGlobalMemory("kokie", reply);
    addToUserMemory(userId, "kokie", reply);

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
  if (message.author.id === client.user.id) return;

  // Only respond to DMs / Group DMs (as before)
  if (!(message.channel.type === "DM" || message.channel.type === "GROUP_DM")) return;

  if (!message.content || message.content.length > 1200) return; // ignore extremely long messages

  const userId = message.author.id;
  const username = message.author.globalName || message.author.username;
  const text = message.content.trim();

  if (isCommand(text, "?persona ")) {
    const newPersona = text.slice("?persona ".length).trim();
    if (newPersona.length < 3) {
      return message.channel.send("Persona too short.");
    }
    globalMemory.persona = newPersona;

    return message.channel.send("Kokie has updated her persona.");
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

  try {
    await message.channel.sendTyping();

    const reply = await askGeminiCombined(userId, text, username);
    if (!reply) return; // deduplicated

    // Send in chunks if too long
    const chunks = reply.match(/[\s\S]{1,2000}/g);
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
