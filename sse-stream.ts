import https from "node:https";
import "dotenv/config";

const postData = JSON.stringify({
	// noCache: true,
	model: "gpt-4",
	stream: true,
	messages: [
		{
			role: "user",
			content: "Write a poem about the sunset.",
		},
	],
});

const options = {
	hostname: "api.openai.com", // Specify the hostname without protocol
	path: "/v1/chat/completions", // Correct path for API endpoint
	method: "POST",
	headers: {
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(postData), // Ensure the length is set correctly
		Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
	},
};

async function main() {
	const req = https.request(options, (res) => {
		console.log(`HEADERS: ${JSON.stringify(res.headers)}`);

		res.on("data", (chunk) => {
			// console.log(`${chunk}`);
		});

		res.on("end", () => {
			console.log("No more data in response.");
		});
	});

	req.on("error", (e) => {
		console.error(`problem with request: ${e}`);
	});

	req.write(postData);
	req.end();
}

main();
