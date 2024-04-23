import http from "node:http";
import "dotenv/config";

const postData = JSON.stringify({
	noCache: true,
	model: "gpt-4",
	stream: true,
	messages: [
		{
			role: "user",
			content: "Write a haiku about the sunset.",
		},
	],
});

const options = {
	hostname: "localhost",
	port: 8787,
	path: "/chat/completions",
	method: "POST",
	headers: {
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(postData), // Ensure the length is set correctly
	},
};

async function main() {
	const req = http.request(options, (res) => {

		res.on("data", (chunk) => {
			console.log(`${chunk}`);
		});

		res.on("end", () => {
			console.log("No more data in response.");
		});
	});

	req.on("error", (e) => {
		console.error(`problem with request: ${e.message}`);
	});

	req.write(postData);
	req.end();
}

main();
