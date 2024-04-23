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

async function readStream(request: http.ClientRequest): Promise<string> {
	return new Promise((resolve, reject) => {
		let data = "";
		request.on("data", (chunk) => {
			data += chunk;
		});
		request.on("end", () => {
			resolve(data);
		});
		request.on("error", (err) => {
			reject(err);
		});
	});
}

export async function POST(request: Request) {
	const req = http.request(options);
	const responseData = await readStream(req);

	return new Response(responseData, {
		headers: {
			"Content-Type": "text/plain",
		},
	});
}
