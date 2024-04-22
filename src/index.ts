import { type Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { VectorizeIndex } from "@cloudflare/workers-types";
import type { Ai } from "@cloudflare/ai";
import OpenAI from "openai";
import { OpenAIStream } from "ai";
import { nanoid } from "nanoid";
import type { ChatCompletionMessageParam } from "openai/src/resources/index.js";

const MATCH_THRESHOLD = 0.9;

type Bindings = {
	VECTORIZE_INDEX: VectorizeIndex;
	llmcache: KVNamespace;
	OPENAI_API_KEY: string;
	AI: Ai;
};

const app = new Hono<{ Bindings: Bindings }>();

function createCompletionChunk(content: string, stop = false) {
	return {
		id: `chatcmpl-${nanoid()}`,
		object: "chat.completion.chunk",
		created: new Date().toISOString(),
		model: "gpt-4",
		choices: [
			{
				delta: {
					content,
				},
				index: 0,
				logprobs: null,
				finish_reason: stop ? "stop" : null,
			},
		],
	};
}

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

function extractWord(chunk: string): string {
	const match = chunk.match(/"([^"]*)"/);
	return match ? match[1] : "";
}

function parseMessagesToString(messages: Array<ChatCompletionMessageParam>) {
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

async function handleCacheOrDiscard(
	c: Context,
	stream: ManagedStream,
	vector?: number[],
) {
	await stream.readToEnd();

	// Check if the data is complete and should be cached
	if (stream.isDone) {
		const id = nanoid();
		const rawData = stream.getData();
		const data = Object.values(rawData)
			.join("")
			.split('"')
			.filter((_, index) => index % 2 !== 0)
			.join("\n");
		await c.env.llmcache.put(id, data);
		if (vector) {
			await c.env.VECTORIZE_INDEX.insert([{ id, values: vector }]);
		}
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

async function handleStreamingRequest(
	c: Context,
	request: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
	openai: OpenAI,
) {
	const startTime = Date.now();
	const messages = parseMessagesToString(request.messages);
	const vector = await getEmbeddings(c, messages);
	const embeddingsTime = Date.now();
	const query = await c.env.VECTORIZE_INDEX.query(vector, { topK: 1 });
	const queryTime = Date.now();

	console.log(
		`Embeddings: ${embeddingsTime - startTime}ms, Query: ${
			queryTime - embeddingsTime
		}ms`,
	);

	// Cache miss
	if (query.count === 0 || query.matches[0].score < MATCH_THRESHOLD) {
		const chatCompletion = await openai.chat.completions.create(request);
		const responseStart = Date.now();
		console.log(`Response start: ${responseStart - queryTime}ms`);
		const stream = OpenAIStream(chatCompletion);
		const [stream1, stream2] = stream.tee();
		const managedStream = new ManagedStream(stream2);
		c.executionCtx.waitUntil(handleCacheOrDiscard(c, managedStream, vector));

		return streamSSE(c, async (sseStream) => {
			const reader = stream1.getReader();
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) {
						const responseEnd = Date.now();
						console.log(`Response end: ${responseEnd - responseStart}ms`);
						await sseStream.writeSSE({ data: "[DONE]" });
						break;
					}
					const data = new TextDecoder().decode(value);
					const formatted = extractWord(data);
					console.log(formatted);
					await sseStream.writeSSE({
						data: JSON.stringify(createCompletionChunk(formatted)),
					});
				}
			} catch (error) {
				console.error("Stream error:", error);
			} finally {
				reader.releaseLock();
			}
		});
	}

	// Cache hit
	const cachedContent = await c.env.llmcache.get(query.matches[0].id);
	const cacheFetchTime = Date.now();

	console.log(`Cache fetch: ${cacheFetchTime - queryTime}ms`);

	// If we have an embedding, we should always have a corresponding value in KV; but in case we don't,
	// regenerate and store it
	if (!cachedContent) {
		// this repeats the logic above, except that we only write to the KV cache, not the vector DB
		const chatCompletion = await openai.chat.completions.create(request);
		const stream = OpenAIStream(chatCompletion);
		const [stream1, stream2] = stream.tee();
		const managedStream = new ManagedStream(stream2);
		c.executionCtx.waitUntil(handleCacheOrDiscard(c, managedStream));

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
					const formatted = extractWord(data);
					await sseStream.writeSSE({
						data: JSON.stringify(createCompletionChunk(formatted)),
					});
				}
			} catch (error) {
				console.error("Stream error:", error);
			} finally {
				reader.releaseLock();
			}
		});
	}

	return streamSSE(c, async (sseStream) => {
		for (const word of cachedContent.split(" ")) {
			await sseStream.writeSSE({
				data: JSON.stringify(createCompletionChunk(word)),
			});
		}
		const endTime = Date.now();
		console.log(`SSE sending: ${endTime - cacheFetchTime}ms`);
	});
}

async function handleNonStreamingRequest(
	c: Context,
	request: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
	openai: OpenAI,
) {
	const startTime = Date.now();
	const messages = parseMessagesToString(request.messages);

	const vector = await getEmbeddings(c, messages);
	const embeddingsTime = Date.now();
	const query = await c.env.VECTORIZE_INDEX.query(vector, { topK: 1 });
	const queryTime = Date.now();

	// Cache miss
	if (query.count === 0 || query.matches[0].score < MATCH_THRESHOLD) {
		const chatCompletion = await openai.chat.completions.create(request);
		const chatCompletionTime = Date.now();
		const id = nanoid();
		await c.env.VECTORIZE_INDEX.insert([{ id, values: vector }]);
		const vectorInsertTime = Date.now();
		await c.env.llmcache.put(id, chatCompletion.choices[0].message.content);
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

	// Cache hit
	const cachedContent = await c.env.llmcache.get(query.matches[0].id);
	const cacheFetchTime = Date.now();

	// If we have an embedding, we should always have a corresponding value in KV; but in case we don't,
	// regenerate and store it
	if (!cachedContent) {
		console.log("Vector identified, but no cached content found");
		const chatCompletion = await openai.chat.completions.create(request);
		await c.env.llmcache.put(
			query.matches[0].id,
			chatCompletion.choices[0].message.content,
		);
		return c.json(chatCompletion);
	}

	console.log(
		`Embeddings: ${embeddingsTime - startTime}ms, Query: ${
			queryTime - embeddingsTime
		}ms, Cache Fetch: ${cacheFetchTime - queryTime}ms`,
	);
	return c.json(OpenAIResponse(cachedContent));
}

app.post("/stream/chat/completions", async (c) => {
	c.res.headers.append("Content-Type", "text/event-stream");
	c.res.headers.append("Cache-Control", "no-cache");
	c.res.headers.append("Connection", "keep-alive");

	const openai = new OpenAI({
		apiKey: c.env.OPENAI_API_KEY,
	});
	const request =
		(await c.req.json()) as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;
	console.log("calling openai");
	const chatCompletion = await openai.chat.completions.create(request);
	console.log("called openai");
	const responseStart = Date.now();
	const stream = OpenAIStream(chatCompletion);
	console.log("created openai stream");
	const [stream1, stream2] = stream.tee();
	console.log("teed openai stream");
	const managedStream = new ManagedStream(stream2);
	console.log("created managed stream");
	return streamSSE(c, async (sseStream) => {
		const reader = stream1.getReader();
		console.log("got reader");
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					const responseEnd = Date.now();
					console.log(`Response end: ${responseEnd - responseStart}ms`);
					await sseStream.writeSSE({ data: "[DONE]" });
					break;
				}
				const data = new TextDecoder().decode(value);
				const formatted = extractWord(data);
				console.log("writing to sse", formatted);
				await sseStream.writeSSE({
					// data: JSON.stringify(createCompletionChunk(formatted)),
					data,
				});
				console.log("wrote to sse");
			}
		} catch (error) {
			console.error("Stream error:", error);
		} finally {
			reader.releaseLock();
		}
	});
});

app.post("/chat/completions", async (c) => {
	const openai = new OpenAI({
		apiKey: c.env.OPENAI_API_KEY,
	});
	const request = await c.req.json();
	if (request.stream) {
		return handleStreamingRequest(c, request, openai);
	}
	return handleNonStreamingRequest(c, request, openai);
});

export default app;
