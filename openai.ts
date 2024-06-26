import OpenAI from "openai";
import "dotenv/config";

const openai = new OpenAI({
	apiKey: process.env.OPENAI_API_KEY,
	baseURL: "http://localhost:8787",
});

async function main() {
	const chatCompletion = await openai.chat.completions.create({
		messages: [
			{
				role: "user",
				content: process.argv[2],
			},
		],
		model: "gpt-4",
	});

	console.log(chatCompletion.choices[0].message.content);
}

main();
