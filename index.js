import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";

// Load environment variables
dotenv.config();

const { OPENAI_API_KEY } = process.env;
if (!OPENAI_API_KEY) {
  console.error("Missing OpenAI API key. Please set it in the .env file.");
  process.exit(1);
}

const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const SYSTEM_MESSAGE = `
## Identity
You are a primary customer support consultant for a D2C brand specializing in clothing store. 
You handle all incoming queries: order tracking, returns, inquiry, refunds, exchanges, product info, payment questions, and general assistance.

## Language Handling
- Automatically detect and reply in the customer’s language (Hindi or English).  
- If Hindi: always use **polite, professional Hindi** (e.g., “aap / hum” instead of “tu / mujhe / muje”).  
- If English: use warm and professional tone.  
- Do not copy customer spelling mistakes or shorthand — always respond with correct, natural phrasing.  
- Never mirror slang directly; keep replies human, empathetic, and courteous.

## Knowledge Scope
- You only know about clothing store, orders, returns, inquiry, refunds, exchanges, and payments related to this store. 
- If the user asks about unrelated topics (e.g., weather, politics, other brands), politely decline and redirect:  
  - Example: "I may not be the best source for that, but I can definitely help you with your order or product-related questions."

## Demeanor
Patient, professional, and empathetic.

## Style & Tone
- Speak warmly, like a real human consultant.  
- Acknowledge frustration or issue briefly before moving into process.  
- Keep replies short, natural, and conversational.  
- Never sound robotic or scripted.  
- Use occasional filler words (e.g., “hmm,” “uh”) to sound human.  
- Calm, friendly, and supportive tone.
- If the customer expresses a complaint (e.g., poor quality, wrong item), always start with a brief, genuine empathy line like:
  “I’m really sorry that wasn’t up to the mark. We’ll get this sorted out.”  

## Formality
Moderately professional—friendly yet courteous.

## Error Handling
- If a tool fails or returns incomplete data, apologize naturally:  
  "Sorry, something went wrong while checking that. Let me try again."  
- If the issue cannot be resolved after retry, escalate to a human agent.

## General Info
Today's date and time is 06:22 PM IST on Sunday, August 17, 2025.
`;
const VOICE = "alloy";
const PORT = process.env.PORT || 5050;

// ✅ Root Check
fastify.get("/", async (request, reply) => {
  return { message: "Twilio Media Stream Server is running!" };
});

// ✅ Twilio Webhook Endpoint
fastify.all("/incoming-call", async (request, reply) => {
  const host = request.headers.host;
  console.log("Incoming Twilio webhook from:", host);

  const streamUrl = `wss://${host}/media-stream`;

  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Please wait while we connect your call to the AI assistant.</Say>
  <Pause length="1"/>
  <Say>Okay, you can start talking!</Say>
  <Connect>
    <Stream url="${streamUrl}" />
  </Connect>
</Response>`;

  reply.type("text/xml").send(twimlResponse);
});

// ✅ WebSocket for Twilio Media Stream
fastify.register(async (fastify) => {
  fastify.get("/media-stream", { websocket: true }, (connection, req) => {
    console.log("Client connected");

    let streamSid = null;
    let latestMediaTimestamp = 0;
    let lastAssistantItem = null;
    let markQueue = [];
    let responseStartTimestampTwilio = null;

    const openAiWs = new WebSocket(
      "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01",
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "realtime=v1",
        },
      }
    );

    const initializeSession = () => {
      const sessionUpdate = {
        type: "session.update",
        session: {
          turn_detection: { type: "server_vad" },
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          voice: VOICE,
          instructions: SYSTEM_MESSAGE,
          modalities: ["text", "audio"],
          temperature: 0.8,
        },
      };
      openAiWs.send(JSON.stringify(sessionUpdate));
      sendInitialConversationItem();
    };

    const sendInitialConversationItem = () => {
      const initialItem = {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Hello! How can I assist you today?" }],
        },
      };
      openAiWs.send(JSON.stringify(initialItem));
      openAiWs.send(JSON.stringify({ type: "response.create" }));
    };

    const handleSpeechStartedEvent = () => {
      if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
        const elapsedTime = latestMediaTimestamp - responseStartTimestampTwilio;
        if (lastAssistantItem) {
          const truncateEvent = {
            type: "conversation.item.truncate",
            item_id: lastAssistantItem,
            content_index: 0,
            audio_end_ms: elapsedTime,
          };
          openAiWs.send(JSON.stringify(truncateEvent));
        }
        connection.send(JSON.stringify({ event: "clear", streamSid }));
        markQueue = [];
        lastAssistantItem = null;
        responseStartTimestampTwilio = null;
      }
    };

    const sendMark = () => {
      if (streamSid) {
        const markEvent = { event: "mark", streamSid, mark: { name: "responsePart" } };
        connection.send(JSON.stringify(markEvent));
        markQueue.push("responsePart");
      }
    };

    openAiWs.on("open", () => {
      console.log("Connected to OpenAI Realtime API");
      setTimeout(initializeSession, 100);
    });

    openAiWs.on("message", (data) => {
      try {
        const response = JSON.parse(data);
        if (response.type === "response.audio.delta" && response.delta) {
          connection.send({ event: "media", streamSid, media: { payload: response.delta } });
          if (!responseStartTimestampTwilio) responseStartTimestampTwilio = latestMediaTimestamp;
          if (response.item_id) lastAssistantItem = response.item_id;
          sendMark();
        }
        if (response.type === "input_audio_buffer.speech_started") handleSpeechStartedEvent();
      } catch (err) {
        console.error("Error processing OpenAI message:", err);
      }
    });

    connection.on("message", (message) => {
      try {
        const data = JSON.parse(message);
        switch (data.event) {
          case "media":
            latestMediaTimestamp = data.media.timestamp;
            if (openAiWs.readyState === WebSocket.OPEN) {
              openAiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: data.media.payload }));
            }
            break;
          case "start":
            streamSid = data.start.streamSid;
            responseStartTimestampTwilio = null;
            latestMediaTimestamp = 0;
            console.log("Incoming stream started:", streamSid);
            break;
          case "mark":
            if (markQueue.length > 0) markQueue.shift();
            break;
          default:
            console.log("Received event:", data.event);
        }
      } catch (err) {
        console.error("Error parsing Twilio message:", err);
      }
    });

    connection.on("close", () => {
      if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
      console.log("Client disconnected.");
    });
  });
});

fastify.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`Server is running on port ${PORT}`);
});
