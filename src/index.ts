import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import OpenAI from "openai";
import { nanoid } from "nanoid";
import { VectorizeIndex } from "@cloudflare/workers-types";
import { OpenAIStream } from "ai";
import { Stream } from "openai/streaming.mjs";

type Message = {
	role: "user" | "assistant" | "system";
	content: string;
};

export interface Env {
	VECTORIZE_INDEX: VectorizeIndex;
	llmcache: KVNamespace;
	openai_api_key: string;
}

type Bindings = {
	VECTORIZE_INDEX: VectorizeIndex;
	llmcache: KVNamespace;
	OPENAI_API_KEY: string;
	AI: unknown;
};

const app = new Hono<{ Bindings: Bindings }>();

function OpenAIResponse(content: string) {
	return {
		choices: [
			{
				message: {
					content,
				},
			},
		],
	};
}

async function logStream(stream: ReadableStream) {
	const reader = stream.getReader();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			console.log("Log Stream Data:", new TextDecoder().decode(value));
		}
	} catch (error) {
		console.error("Error reading stream:", error);
	} finally {
		reader.releaseLock();
	}
}

app.post("/stream/chat/completions", async (c) => {
	const openai = new OpenAI({
		apiKey: c.env.OPENAI_API_KEY,
	});
	const body =
		(await c.req.json()) as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;
	const forwardRequest = await openai.chat.completions.create(body);
	const stream = OpenAIStream(forwardRequest);
	const [stream1, stream2] = stream.tee();
	c.executionCtx.waitUntil(logStream(stream2));
	return streamSSE(c, async (stream) => {
		await stream.writeSSE({
			data: `{"message":"hello, world!"}`,
		});
		await stream.writeSSE({
			data: "[DONE]",
		});
	});
});

app.post("/chat/completions", async (c) => {
	const startTime = Date.now();

	const openai = new OpenAI({
		apiKey: c.env.OPENAI_API_KEY,
	});

	const openaiRequest = await c.req.json();

	const messages = openaiRequest.messages
		.map((message: Message) => `${message.role}: ${message.content}`)
		.join("\n");

	console.log(messages);

	const embeddingsRequest = await c.env.AI.run("@cf/baai/bge-small-en-v1.5", {
		text: messages,
	});

	const embeddingsTime = Date.now();

	const vector = embeddingsRequest.data[0];

	const query = await c.env.VECTORIZE_INDEX.query(vector, { topK: 1 });

	const queryTime = Date.now();

	if (query.count === 0 || query.matches[0].score < 0.7) {
		const chatCompletion = await openai.chat.completions.create({
			...openaiRequest,
			stream: false,
		});
		const chatCompletionTime = Date.now();
		const id = nanoid();
		await c.env.VECTORIZE_INDEX.insert([{ id, values: vector }]);
		const vectorInsertTime = Date.now();
		const kv = c.env.llmcache;
		await kv.put(id, JSON.stringify(chatCompletion.choices[0].message.content));
		const kvInsertTime = Date.now();

		console.log(
			`Embeddings: ${embeddingsTime - startTime}ms, Query: ${
				queryTime - embeddingsTime
			}ms, Chat Completion: ${
				chatCompletionTime - queryTime
			}ms, Vector Insert: ${
				vectorInsertTime - chatCompletionTime
			}ms, KV Insert: ${kvInsertTime - vectorInsertTime}ms`,
		);
		return c.json(chatCompletion);
	}

	console.log("Cache hit!");
	const cachedContent = await c.env.llmcache.get(query.matches[0].id);
	const cacheFetchTime = Date.now();

	console.log(cachedContent);

	if (!cachedContent) {
		const chatCompletion = await openai.chat.completions.create({
			...openaiRequest,
			stream: false,
		});
		const id = nanoid();
		await c.env.VECTORIZE_INDEX.insert([{ id, values: vector }]);
		const kv = c.env.llmcache;
		await kv.put(id, JSON.stringify(chatCompletion.choices[0].message.content));
		return c.json(chatCompletion);
	}

	console.log(
		`Embeddings: ${embeddingsTime - startTime}ms, Query: ${
			queryTime - embeddingsTime
		}ms, Cache Fetch: ${cacheFetchTime - queryTime}ms`,
	);
	return c.json(OpenAIResponse(cachedContent));
});

export default app;
