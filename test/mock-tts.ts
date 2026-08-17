// Instant fake TTS: returns recognizable bytes so we test plumbing, not Kokoro.
Bun.serve({
  port: 17998,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/v1/audio/speech") {
      const { input } = await req.json();
      if (typeof input === "string" && input.includes("FAILME")) {
        return new Response("boom", { status: 500 });
      }
      if (typeof input === "string" && input.includes("SLOWME")) {
        await new Promise((r) => setTimeout(r, 400));
      }
      return new Response(Buffer.from(`RIFF-FAKE-WAV:${input}`), {
        headers: { "Content-Type": "audio/wav" },
      });
    }
    return new Response("nope", { status: 404 });
  },
});
console.log("mock tts on 17998");
