import { Hono } from "hono";
import OpenAI from "openai";
import { nanoid } from "nanoid";
import { VectorizeIndex } from "@cloudflare/workers-types";

type Message = {
	role: "user" | "assistant" | "system";
	content: string;
};

export interface Env {
	VECTORIZE: VectorizeIndex;
	llmcache: KVNamespace;
	openai_api_key: string;
}

type Bindings = {
	VECTORIZE: VectorizeIndex;
	llmcache: KVNamespace;
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

app.post("/chat/completions", async (c) => {
	const openai = new OpenAI({
		apiKey: c.env.OPENAI_API_KEY,
	});

	const openaiRequest = await c.req.json();

	// concatenate all messages into a single string
	const messages = openaiRequest.messages
		.map((message: Message) => `${message.role}: ${message.content}`)
		.join("\n");

	const embeddingsRequest = await openai.embeddings.create({
		model: "text-embedding-3-small",
		input: messages,
	});

	const vector = embeddingsRequest.data[0].embedding;

	const query = await c.env.VECTORIZE.query(vector, { topK: 1 });

	if (query.count === 0 || query.matches[0].score < 0.7) {
		// cache miss, proceed to LLM
		// also need to handle case where vectors are returned, but too dissimilar
		const chatCompletion = await openai.chat.completions.create(openaiRequest);
		const id = nanoid();
		await c.env.VECTORIZE.insert([{ id, values: vector }]);
		const kv = c.env.llmcache;
		await kv.put(id, JSON.stringify(chatCompletion.choices[0].message.content));
		return c.json(chatCompletion);
	}
	console.log("cache hit!");
	const { id } = query.matches[0];
	const cachedContent = await c.env.llmcache.get(id);
	if (!cachedContent) {
		// this should never happen since we should hava a KV cache hit whenever we
		// have a vector cache hit
		const chatCompletion = await openai.chat.completions.create(openaiRequest);
		const id = nanoid();
		await c.env.VECTORIZE.insert([{ id, values: vector }]);
		const kv = c.env.llmcache;
		await kv.put(id, JSON.stringify(chatCompletion.choices[0].message.content));
		return c.json(chatCompletion);
	}
	return c.json(OpenAIResponse(cachedContent));
});

export default app;
