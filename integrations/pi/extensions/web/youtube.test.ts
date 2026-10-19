import test from "node:test";
import assert from "node:assert/strict";
import { clock, parseVtt, renderTranscript, transcriptText, youtubeVideoId } from "./youtube.ts";

test("recognizes YouTube video URLs and nothing else", () => {
  const id = "zjkBMFhNj_g";
  for (const u of [
    `https://www.youtube.com/watch?v=${id}`,
    `https://youtube.com/watch?v=${id}&t=120s&list=PL123`,
    `https://m.youtube.com/watch?v=${id}`,
    `https://music.youtube.com/watch?v=${id}`,
    `https://youtu.be/${id}?si=abc`,
    `https://www.youtube.com/shorts/${id}`,
    `https://www.youtube.com/live/${id}`,
    `https://www.youtube.com/embed/${id}`,
    `https://www.youtube-nocookie.com/embed/${id}`,
  ]) assert.equal(youtubeVideoId(u), id, u);
  for (const u of [
    "https://www.youtube.com/@karpathy",
    "https://www.youtube.com/playlist?list=PL123",
    "https://www.youtube.com/watch?v=short",
    "https://notyoutube.com/watch?v=zjkBMFhNj_g",
    "https://youtube.com.evil.example/watch?v=zjkBMFhNj_g",
    "ftp://youtu.be/zjkBMFhNj_g",
    "not a url",
  ]) assert.equal(youtubeVideoId(u), null, u);
});

test("collapses YouTube's rolling auto-caption cues", () => {
  const vtt = `WEBVTT
Kind: captions
Language: en

00:00:00.160 --> 00:00:02.869 align:start position:0%
 
hi<00:00:00.480><c> everyone</c><00:00:00.880><c> so</c>

00:00:02.869 --> 00:00:02.879 align:start position:0%
hi everyone so
 

00:00:02.879 --> 00:00:05.110 align:start position:0%
hi everyone so
recently<00:00:03.360><c> I</c><00:00:03.520><c> gave</c>

00:00:05.110 --> 00:00:05.120 align:start position:0%
recently I gave
 

00:01:05.120 --> 00:01:07.000 align:start position:0%
recently I gave
a &amp; b talk
`;
  assert.deepEqual(parseVtt(vtt), [
    { start: 0.16, text: "hi everyone so" },
    { start: 2.879, text: "recently I gave" },
    { start: 65.12, text: "a & b talk" },
  ]);
});

test("marks the transcript about once a minute", () => {
  const text = transcriptText([
    { start: 0.16, text: "hi everyone so" },
    { start: 2.879, text: "recently I gave" },
    { start: 65.12, text: "a & b talk" },
    { start: 3700, text: "the end" },
  ]);
  assert.equal(text, "[0:00] hi everyone so recently I gave\n\n[1:05] a & b talk\n\n[1:01:40] the end");
  assert.equal(clock(59.9), "0:59");
});

test("renders metadata, chapters, and a no-captions note", () => {
  const md = renderTranscript(
    { id: "zjkBMFhNj_g", title: "Intro to LLMs", channel: "Andrej Karpathy", duration: 3588, upload_date: "20231122", chapters: [{ start_time: 0, title: "Intro" }] },
    "https://www.youtube.com/watch?v=zjkBMFhNj_g",
    null,
  );
  assert.match(md, /^# Intro to LLMs\n\nAndrej Karpathy · 59:48 · 2023-11-22 · https:\/\/www\.youtube\.com\/watch\?v=zjkBMFhNj_g/);
  assert.match(md, /## Chapters\n\n- \[0:00\] Intro/);
  assert.match(md, /No English captions/);
});
