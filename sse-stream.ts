import { Stream } from "./streaming";
import "dotenv/config";

async function main() {
	// const response = await fetch("http://localhost:8787/chat/completions", {
	try {
		const response = await fetch(
			// "https://api.openai.com/v1/chat/completions",
			// "http://localhost:8787/chat/completions",
			"https://llmcache.unkey.workers.dev/chat/completions",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
				},
				body: JSON.stringify({
					noCache: true,
					model: "gpt-4",
					stream: true,
					messages: [
						{
							role: "user",
							content: "Write a short poem about the sunset.",
						},
					],
				}),
			},
		);

		if (!response.ok) {
			console.error(
				`HTTP Error: ${response.status} - ${await response.text()}`,
			);
		}

		const controller = new AbortController();
		const stream = Stream.fromSSEResponse(response, controller);
		let i = 0;
		for await (const sse of stream) {
			i++;
			if (i === 1) {
				console.log("iterating");
			}
		}
	} catch (e) {
		console.error(e);
	}
}

main();
