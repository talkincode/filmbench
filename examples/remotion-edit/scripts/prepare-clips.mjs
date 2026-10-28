#!/usr/bin/env node
/**
 * 准备剪辑素材：把已有的舆情录制片段放进 public/clips/。
 *
 * 素材不进 Git（15MB 的三段 mp4）。有本地录制就直接复制，
 * 没有就用 ffmpeg 生成三段可辨识的测试片段，保证这个例子在任何机器上都能跑通。
 */
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const outDir = path.join(root, 'public/clips');
fs.mkdirSync(outDir, {recursive: true});

const CANDIDATES = [
  process.env.FILMBENCH_CLIP_DIR,
  '/Users/wangjuntao/github/filmbench-demo/spillway-landmarks/source',
].filter(Boolean);

const plan = [
  {id: 'landmark-1', index: 1},
  {id: 'landmark-3', index: 3},
  {id: 'landmark-6', index: 6},
];

let copied = 0;
for (const {id, index} of plan) {
  const dest = path.join(outDir, `${id}.mp4`);
  const source = CANDIDATES.map((dir) => path.join(dir, `cap-${index}.mp4`)).find((p) => fs.existsSync(p));
  if (source) {
    fs.copyFileSync(source, dest);
    copied += 1;
    console.log(`复制 ${path.basename(source)} → public/clips/${id}.mp4`);
    continue;
  }
  // 兜底：三段不同色调 + 位移的测试图，时长足够剪辑
  const hue = [190, 25, 265][index % 3];
  execFileSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `color=c=0x11202a:s=768x1024:r=24:d=9`,
    '-vf', `drawbox=x=0:y=0:w=768:h=1024:color=hsv(${hue},0.3,0.2):t=fill,noise=alls=12:allf=t`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', dest,
  ]);
  console.log(`生成测试片段 public/clips/${id}.mp4`);
}

if (!copied) {
  console.log('（没有找到本地录制，用测试片段；设置 FILMBENCH_CLIP_DIR 指向 source/ 目录可用真素材）');
}
