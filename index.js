import "dotenv/config";
import { Client } from "discord.js-selfbot-v13";
import { GoogleGenAI } from "@google/genai";

// ------------------- CONFIG -------------------
const ai = new GoogleGenAI({ apiKey: process.env.GENAI_API_KEY });
const client = new Client();
const MODEL = "gemini-2.0-flash";

const persona = `
You are Kokie (a girl). You speak in a cute, friendly, and natural way, similar to a real person.
You keep conversations short and simple.
You don't use many emojis.
You avoid talking about programming or scripts and keep private topics to yourself.
Always stay playful and gentle, but not overly talkative.
`;

// ------------------- MEMORY -------------------
const memory = new Map();

// Get memory for user, initializing with persona if empty
function getUserMemory(userId) {
  if (!memory.has(userId)) {
    memory.set(userId, { persona: persona.trim(), userMsgs: [] });
  }
  return memory.get(userId);
}

function addToMemory(userId, msg, isUser = true) {
  const mem = getUserMemory(userId);
  if (isUser) {
    mem.userMsgs.push(msg);
    const MAX_MEMORY = 10;
    if (mem.userMsgs.length > MAX_MEMORY) mem.userMsgs.shift(); // remove oldest
  }
}

// ------------------- GEMINI -------------------
async function askGemini(userId, userMessage) {
  try {
    const mem = getUserMemory(userId);
    const context = mem.persona + "\nRecent messages:\n" + mem.userMsgs.join("\n");
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: context + "\n\nUser says: " + userMessage,
      generationConfig: { temperature: 0.9, topK: 1, topP: 1, maxOutputTokens: 50 },
    });
    return response.text || "Kokie is confused~";
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

  try {
    if (message.content.length > 50) return;

    // Save user message
    addToMemory(message.author.id, "User: " + message.content);

    await message.channel.sendTyping();
    const reply = await askGemini(message.author.id, message.content);

    // Save Kokie's reply
    addToMemory(message.author.id, "you: " + reply);

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
client.login(process.env.DISCORD_USER_TOKEN)
