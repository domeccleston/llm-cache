import { Context, Hono } from "hono";
// import { streamSSE } from "hono/streaming";
import { VectorizeIndex } from "@cloudflare/workers-types";
import { type Ai } from "@cloudflare/ai";
import OpenAI from "openai";
import { OpenAIStream } from "ai";
import { nanoid } from "nanoid";
import { StreamingApi } from "hono/utils/stream";
import { open } from "fs";
import { ChatCompletionMessageParam } from "openai/src/resources/index.js";

export interface SSEMessage {
	data: string;
	event?: string;
	id?: string;
	retry?: number;
}

export class SSEStreamingApi extends StreamingApi {
	constructor(writable: WritableStream, readable: ReadableStream) {
		super(writable, readable);
	}

	async writeSSE(message: SSEMessage) {
		const data = message.data
			.split("\n")
			.map((line) => {
				return `data: ${line}`;
			})
			.join("\n");

		const sseData =
			[
				message.event && `event: ${message.event}`,
				data,
				message.id && `id: ${message.id}`,
				message.retry && `retry: ${message.retry}`,
			]
				.filter(Boolean)
				.join("\n") + "\n\n";

		await this.write(sseData);
	}
}

const run = async (
	stream: SSEStreamingApi,
	cb: (stream: SSEStreamingApi) => Promise<void>,
	onError?: (e: Error, stream: SSEStreamingApi) => Promise<void>,
) => {
	try {
		await cb(stream);
	} catch (e) {
		if (e instanceof Error && onError) {
			await onError(e, stream);

			await stream.writeSSE({
				event: "error",
				data: e.message,
			});
		} else {
			console.error(e);
		}
	} finally {
		stream.close();
	}
};

export const streamSSE = (
	c: Context,
	cb: (stream: SSEStreamingApi) => Promise<void>,
	onError?: (e: Error, stream: SSEStreamingApi) => Promise<void>,
) => {
	const { readable, writable } = new TransformStream();
	const stream = new SSEStreamingApi(writable, readable);

	c.header("Transfer-Encoding", "chunked");
	c.header("Content-Type", "text/event-stream");
	c.header("Cache-Control", "no-cache");
	c.header("Connection", "keep-alive");

	run(stream, cb, onError);

	return c.newResponse(stream.responseReadable);
};

// HONO

const MATCH_THRESHOLD = 0.75;

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

async function handleStreamingRequest(
	c: Context,
	request: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
	openai: OpenAI,
) {
	const startTime = Date.now();

	const chatCompletion = await openai.chat.completions.create(request);
	const stream = OpenAIStream(chatCompletion);
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

	// Cache hit
	const cachedContent = await c.env.llmcache.get(query.matches[0].id);
	const cacheFetchTime = Date.now();

	// If we have an embedding, we should always have a corresponding value in KV; but in case we don't,
	// regenerate and store it
	if (!cachedContent) {
		const chatCompletion = await openai.chat.completions.create(request);
		await c.env.llmcache.put(
			query.matches[0].id,
			JSON.stringify(chatCompletion.choices[0].message.content),
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

app.post("/chat/completions", async (c) => {
	const openai = new OpenAI({
		apiKey: c.env.OPENAI_API_KEY,
	});
	const request = await c.req.json();

	if (request.stream) {
		return handleStreamingRequest(c, request, openai);
		// biome-ignore lint/style/noUselessElse: I hate this rule but I use Biome for work and it's a pain to disable it
	} else {
		return handleNonStreamingRequest(c, request, openai);
	}
});

export default app;
