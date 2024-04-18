import { Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { VectorizeIndex } from "@cloudflare/workers-types";
import { type Ai } from "@cloudflare/ai";
import OpenAI from "openai";
import { OpenAIStream } from "ai";
import { nanoid } from "nanoid";

const MATCH_THRESHOLD = 0.7;

type Message = {
	role: "user" | "assistant" | "system";
	content: string;
};

type Bindings = {
	VECTORIZE_INDEX: VectorizeIndex;
	llmcache: KVNamespace;
	OPENAI_API_KEY: string;
	AI: Ai;
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

function parseMessagesToString(messages: Message[]) {
	return messages
		.map((message) => `${message.role}: ${message.content}`)
		.join("\n");
}

async function getEmbeddings(c: Context, messages: string) {
	const embeddingsRequest = await c.env.AI.run("@cf/baai/bge-small-en-v1.5", {
		text: messages,
	});

	return embeddingsRequest.data[0];
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

class ManagedStream {
	stream: ReadableStream;
	reader: ReadableStreamDefaultReader<Uint8Array>;
	isDone: boolean;
	data: string;
	isComplete: boolean;

	constructor(stream: ReadableStream) {
		this.stream = stream;
		this.reader = this.stream.getReader();
		this.isDone = false;
		this.data = "";
		this.isComplete = false;
	}

	async readToEnd() {
		try {
			while (true) {
				const { done, value } = await this.reader.read();
				if (done) {
					this.isDone = true;
					break;
				}
				this.data += new TextDecoder().decode(value);
			}
		} catch (error) {
			console.error("Stream error:", error);
			this.isDone = false;
		} finally {
			this.reader.releaseLock();
		}
		return this.isDone;
	}

	checkComplete() {
		if (this.data.includes("[DONE]")) {
			this.isComplete = true;
		}
	}

	getReader() {
		return this.reader;
	}

	getData() {
		return this.data;
	}
}

async function handleCacheOrDiscard(stream: ManagedStream, kv: KVNamespace) {
	// Read the stream to the end and process it
	await stream.readToEnd();

	// Check if the data is complete and should be cached
	if (stream.isDone) {
		const id = nanoid();
		const data = stream.getData();
		await kv.put(id, data);
		console.log("Data cached in KV with ID:", id);
	} else {
		console.log("Data discarded, did not end properly.");
	}
}

app.get("/kv", async (c) => {
	const kv = c.env.llmcache;
	const keys = await kv.get("0sSw6Y4abKJ3atBMcWhHd");
	return c.json(keys);
});

app.post("/stream/chat/completions", async (c) => {
	const openai = new OpenAI({
		apiKey: c.env.OPENAI_API_KEY,
	});
	const body =
		(await c.req.json()) as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;
	const forwardRequest = await openai.chat.completions.create(body);
	const stream = OpenAIStream(forwardRequest);
	const [stream1, stream2] = stream.tee();
	const managedStream = new ManagedStream(stream2);
	c.executionCtx.waitUntil(handleCacheOrDiscard(managedStream, c.env.llmcache));
	return streamSSE(c, async (sseStream) => {
		const reader = stream1.getReader();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					await sseStream.writeSSE({ data: "[DONE]" });
					break;
				}
				const data = new TextDecoder().decode(value);
				await sseStream.writeSSE({
					data: `{"message":${JSON.stringify(data)}}`,
				});
			}
		} catch (error) {
			console.error("Stream error:", error);
		} finally {
			reader.releaseLock();
		}
	});
});

app.post("/chat/completions", async (c) => {
	const startTime = Date.now();

	const openai = new OpenAI({
		apiKey: c.env.OPENAI_API_KEY,
	});

	const openaiRequest = await c.req.json();

	const messages = parseMessagesToString(openaiRequest.messages);

	const vector = await getEmbeddings(c, messages);

	const embeddingsTime = Date.now();

	const query = await c.env.VECTORIZE_INDEX.query(vector, { topK: 1 });

	const queryTime = Date.now();

	if (query.count === 0 || query.matches[0].score < MATCH_THRESHOLD) {
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
