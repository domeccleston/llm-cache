import OpenAI from "openai";
import "dotenv/config";

const openai = new OpenAI({
	apiKey: process.env.OPENAI_API_KEY,
	baseURL: "http://localhost:55897/stream",
});

async function main() {
	const query = process.argv[2];
	const chatCompletion = await openai.chat.completions.create({
		messages: [
			{
				role: "user",
				content: process.argv[2],
			},
		],
		model: "gpt-4",
		stream: true,
	});

	for await (const chunk of chatCompletion) {
		console.log(chunk);
	}
}

main();
