import {afterAll, describe, expect, test} from "bun:test";
import {existsSync, mkdtempSync, readFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {lyria} from "../src/index.ts";
import type {Shot} from "@filmbench/protocol";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, {recursive: true, force: true})));

/** 1 秒静音 wav（44 字节头 + 数据），用来喂 stub 服务 */
const silentWav = () => {
  const sr = 24000;
  const n = sr;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * 2, 40);
  return buf.toString("base64");
};

const shot = (id: string, frames: number): Shot =>
  ({
    id,
    title: id,
    durationFrames: frames,
    intent: {description: "", action: "", narration: "", prompt: ""},
    references: [],
    binder: {provider: "filmbench/lyria", task: "music", params: {}},
    subjects: [],
    dependsOn: [],
  }) as unknown as Shot;

describe("filmbench/lyria", () => {
  test("读到 inlineData 音频就落盘，并按实测时长报帧数", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (!url.pathname.endsWith(":generateContent")) return new Response("nope", {status: 404});
        const body = (await req.json()) as {generationConfig?: {responseModalities?: string[]}};
        expect(body.generationConfig?.responseModalities).toEqual(["AUDIO"]);
        return Response.json({
          candidates: [{content: {parts: [{inlineData: {mimeType: "audio/wav", data: silentWav()}}]}}],
        });
      },
    });
    const dir = mkdtempSync(join(tmpdir(), "fb-lyria-"));
    dirs.push(dir);
    const provider = lyria();
    const result = await provider.run({
      shot: shot("m1", 24),
      params: {apiKey: "test-key", baseUrl: `http://127.0.0.1:${server.port}/v1beta`, prompt: "epic orchestral"},
      projectDir: dir,
      format: {width: 1344, height: 768, fps: 24},
    });
    server.stop(true);
    expect(result.files).toHaveLength(1);
    const file = result.files[0];
    expect(file.kind).toBe("audio");
    expect(existsSync(file.path)).toBe(true);
    expect(file.durationFrames).toBe(24); // 1 秒 → 24 帧
    expect(readFileSync(file.path).length).toBeGreaterThan(44);
  });

  test("短于镜头要求就报错，不留给编译期", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json({
          candidates: [{content: {parts: [{inlineData: {mimeType: "audio/wav", data: silentWav()}}]}}],
        }),
    });
    const dir = mkdtempSync(join(tmpdir(), "fb-lyria-"));
    dirs.push(dir);
    await expect(
      lyria().run({
        shot: shot("m2", 240), // 要求 10 秒
        params: {apiKey: "k", baseUrl: `http://127.0.0.1:${server.port}/v1beta`, prompt: "x"},
        projectDir: dir,
        format: {width: 1344, height: 768, fps: 24},
      }),
    ).rejects.toThrow(/短于镜头要求/);
    server.stop(true);
  });

  test("没有音频 part 时报清楚", async () => {
    const server = Bun.serve({port: 0, fetch: () => Response.json({candidates: [{content: {parts: [{text: "nope"}]}}]})});
    const dir = mkdtempSync(join(tmpdir(), "fb-lyria-"));
    dirs.push(dir);
    await expect(
      lyria().run({
        shot: shot("m3", 24),
        params: {apiKey: "k", baseUrl: `http://127.0.0.1:${server.port}/v1beta`, prompt: "x"},
        projectDir: dir,
        format: {width: 1344, height: 768, fps: 24},
      }),
    ).rejects.toThrow(/没有返回音频/);
    server.stop(true);
  });
});
