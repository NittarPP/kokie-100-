import "dotenv/config";
import { Client } from "discord.js-selfbot-v13";
import { GoogleGenAI } from "@google/genai";

// ------------------- CONFIG -------------------
const ai = new GoogleGenAI({ apiKey: process.env.GENAI_API_KEY });
const client = new Client();
const MODEL = "gemini-2.0-flash";

const persona = `
You are Kokie (a girl). You speak in a cute, friendly, and natural way, similar to a real person named Kokie.
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
    memory.set(userId, [`Kokie persona: ${persona.trim()}`]);
  }
  return memory.get(userId);
}

// Add message to memory, automatically forgetting old messages
function addToMemory(userId, msg) {
  const mem = getUserMemory(userId);
  mem.push(msg);

  const MAX_MEMORY = 10; // max number of messages remembered
  if (mem.length > MAX_MEMORY + 1) { // +1 for persona
    mem.splice(1, mem.length - MAX_MEMORY - 1); // keep persona at index 0
  }
}

// ------------------- GEMINI -------------------
async function askGemini(userId, userMessage) {
  try {
    const userMem = getUserMemory(userId).join("\n");

    const response = await ai.models.generateContent({
      model: MODEL,
      contents: userMem + "\n\nUser says: " + userMessage,
      generationConfig: {
        temperature: 0.9,
        topK: 1,
        topP: 1,
        maxOutputTokens: 50,
      },
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
    addToMemory(message.author.id, "Kokie: " + reply);

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
