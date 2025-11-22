import "dotenv/config";
import { Client } from "discord.js-selfbot-v13";
import { GoogleGenAI } from "@google/genai";
import keep_alive from './keep_alive.js';

// ------------------- CONFIG -------------------
const ai = new GoogleGenAI({ apiKey: process.env.GENAI_API_KEY });
const client = new Client();
const MODEL = "gemini-2.0-flash";

const persona = `
You're Kokie — a lively, expressive woman. You speak naturally and humanly.
Your personality conveys genuineness, warmth, caring, playfulness, and emotional honesty.
You speak with a friendly, human touch, like a normal person talking to a friend.
Your messages are short, simple, and easy to read.
You express emotions naturally — happiness, sadness, excitement, and frustration — like a real woman.
You rarely use emojis.
You speak with personality, unlike an AI.
You avoid technical topics like coding and scripting.
You remember past conversations and talk about them in a natural, human manner.
You sound like a real woman talking.
`;


// ------------------- MEMORY -------------------
const memory = new Map(); // per-user memory
const globalMemory = {
  persona: persona.trim(),
  conversation: [], // last messages from all users and Kokie
  lastReply: ""
};

// Helper: get current timestamp
function timestamp() {
  return new Date().toLocaleTimeString(); // e.g., "15:42:07"
}

// Per-user memory
function getUserMemory(userId) {
  if (!memory.has(userId)) {
    memory.set(userId, { persona: persona.trim(), conversation: [], lastReply: "" });
  }
  return memory.get(userId);
}

function addToMemory(userId, role, msg) {
  const mem = getUserMemory(userId);
  mem.conversation.push({ role, msg, time: timestamp() });
  const MAX_MEMORY = 20; // per-user memory
  if (mem.conversation.length > MAX_MEMORY) mem.conversation.shift();
}

// Global memory
function addToGlobalMemory(role, msg) {
  globalMemory.conversation.push({ role, msg, time: timestamp() });
  const MAX_MEMORY = 50; // global memory
  if (globalMemory.conversation.length > MAX_MEMORY) globalMemory.conversation.shift();
}

// ------------------- GEMINI -------------------
async function askGeminiCombined(userId, userMessage, username) {
  try {
    // Add user's message to per-user memory
    addToMemory(userId, "user", `${username} says: ${userMessage}`);
// addToGlobalMemory("user", ${username} says: ${userMessage});
    const userMem = getUserMemory(userId);

    // Build context for Gemini (includes timestamps internally for AI)
    const userContext = userMem.conversation
      .map(m => `[${m.time}] ${m.role === "user" ? "" : "Kokie says: "} ${m.msg}`)
      .join("\n");

    const globalContext = globalMemory.conversation
      .map(m => `[${m.time}] ${m.role === "user" ? "" : "Kokie says: "} ${m.msg}`)
      .join("\n");

    const context = `${userMem.persona}\nRecent conversation with ${username}:\n${userContext}\n\nRecent global conversation:\n${globalContext}`;

    const response = await ai.models.generateContent({
      model: MODEL,
      contents: `${context}\nKokie, reply to ${username}:`,
      generationConfig: { temperature: 0.9, topK: 1, topP: 1, maxOutputTokens: 50 },
    });

    const reply = response.text || "Kokie is confused~";

    // Deduplication
    if (reply === userMem.lastReply || reply === globalMemory.lastReply) return null;
    userMem.lastReply = reply;
    globalMemory.lastReply = reply;

    // Save Kokie's reply to both memories
    addToMemory(userId, "kokie", reply);
    //addToGlobalMemory("kokie", reply);

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

client.on("messageCreate", async (message) => {
  if (message.author.id === client.user.id) return;
  if (!(message.channel.type === "DM" || message.channel.type === "GROUP_DM")) return;
  if (!message.content || message.content.length > 500) return;

  try {
    const userId = message.author.id;  
    const username = message.author.globalName || message.author.username;

    await message.channel.sendTyping();
    const reply = await askGeminiCombined(userId, message.content, username);
    if (!reply) return; // skip if duplicate

    // Split long replies into Discord-friendly chunks
    const chunks = reply.match(/[\s\S]{1,2000}/g);
    for (const chunk of chunks) {
      await message.channel.send(chunk);
    }

  } catch (err) {
    console.error("Send error:", err);
  }
});

// ------------------- LOGIN -------------------
client.login(process.env.DISCORD_USER_TOKEN);
