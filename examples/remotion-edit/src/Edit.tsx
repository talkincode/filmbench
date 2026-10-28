import React from 'react';
import {
  AbsoluteFill,
  Easing,
  OffthreadVideo,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {TransitionSeries, linearTiming} from '@remotion/transitions';
import {fade} from '@remotion/transitions/fade';
import {slide} from '@remotion/transitions/slide';

export const EDIT_FRAMES = 360;

const SERIF = '"Songti SC", "Noto Serif SC", serif';
const MONO = '"SF Mono", Menlo, monospace';

/** 素材层：固定画幅里做缓慢推镜（1.04→1.12），让静帧机位也有呼吸 */
const Plate: React.FC<{
  file: string;
  startFrom?: number;
  from?: number;
  to?: number;
  dim?: number;
  children?: React.ReactNode;
}> = ({file, startFrom = 0, from = 1.0, to = 1.1, dim = 0, children}) => {
  const frame = useCurrentFrame();
  const {durationInFrames} = useVideoConfig();
  return (
    <AbsoluteFill style={{backgroundColor: '#080b0d'}}>
      <AbsoluteFill
        style={{
          scale: interpolate(frame, [0, durationInFrames - 1], [from, to], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
            easing: Easing.bezier(0.25, 0.1, 0.25, 1),
          }),
        }}
      >
        <OffthreadVideo
          src={staticFile(file)}
          startFrom={startFrom}
          muted
          style={{width: '100%', height: '100%', objectFit: 'cover'}}
        />
      </AbsoluteFill>
      <AbsoluteFill
        style={{
          background:
            'radial-gradient(ellipse at 50% 46%, rgba(0,0,0,0) 45%, rgba(0,0,0,0.55) 100%)',
        }}
      />
      {dim > 0 ? <AbsoluteFill style={{backgroundColor: `rgba(6,9,11,${dim})`}} /> : null}
      {children}
    </AbsoluteFill>
  );
};

/** 下三分之一字幕：编号 + 地名 + 一句说明，短线先拉开，文字再上浮 */
const Caption: React.FC<{index: string; name: string; note: string; delay?: number; exitAt?: number}> = ({
  index,
  name,
  note,
  delay = 6,
  exitAt,
}) => {
  const frame = useCurrentFrame();
  const {fps, durationInFrames} = useVideoConfig();
  const out = exitAt ?? durationInFrames - 6;
  const leave = interpolate(frame, [out, out + 12], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const enter = (offset: number, distance: number) =>
    interpolate(frame, [delay + offset, delay + offset + fps * 0.6], [distance, 0], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
      easing: Easing.bezier(0.16, 1, 0.3, 1),
    });
  return (
    <AbsoluteFill style={{justifyContent: 'flex-end', padding: '0 0 72px 84px'}}>
      <div
        style={{
          opacity:
            interpolate(frame, [delay, delay + fps * 0.4], [0, 1], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            }) * leave,
        }}
      >
        <div
          style={{
            fontFamily: MONO,
            fontSize: 13,
            letterSpacing: 4,
            color: 'rgba(238,231,216,0.62)',
            translate: `0px ${enter(0, 8)}px`,
          }}
        >
          云梦未平 · {index}
        </div>
        <div
          style={{
            marginTop: 14,
            width: interpolate(frame, [delay, delay + fps * 0.5], [0, 44], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
              easing: Easing.bezier(0.16, 1, 0.3, 1),
            }),
            height: 1,
            backgroundColor: 'rgba(238,231,216,0.55)',
          }}
        />
        <div
          style={{
            marginTop: 18,
            fontFamily: SERIF,
            fontSize: 46,
            letterSpacing: 3,
            color: '#f3ecdd',
            translate: `0px ${enter(4, 14)}px`,
          }}
        >
          {name}
        </div>
        <div
          style={{
            marginTop: 10,
            fontFamily: SERIF,
            fontSize: 21,
            letterSpacing: 1.5,
            color: 'rgba(238,231,216,0.76)',
            translate: `0px ${enter(8, 12)}px`,
          }}
        >
          {note}
        </div>
      </div>
    </AbsoluteFill>
  );
};

/** 片名：字距收紧着落，kicker 先出现，短线从中间往两边拉开 */
const TitleCard: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const spread = interpolate(frame, [4, 4 + fps * 0.9], [26, 6], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });
  return (
    <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center'}}>
      <div
        style={{
          fontFamily: MONO,
          fontSize: 13,
          letterSpacing: 6,
          color: 'rgba(238,231,216,0.6)',
          opacity: interpolate(frame, [0, fps * 0.6], [0, 1], {extrapolateRight: 'clamp'}),
        }}
      >
        云梦未平
      </div>
      <div
        style={{
          marginTop: 26,
          fontFamily: SERIF,
          fontSize: 96,
          color: '#f5eee0',
          letterSpacing: spread,
          opacity: interpolate(frame, [6, 6 + fps * 0.7], [0, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          }),
          translate: `0px ${interpolate(frame, [6, 6 + fps * 0.7], [18, 0], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          })}px`,
        }}
      >
        沿水而行
      </div>
      <div
        style={{
          marginTop: 30,
          width: interpolate(frame, [fps * 0.9, fps * 1.6], [0, 220], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
          height: 1,
          backgroundColor: 'rgba(173,58,32,0.85)',
        }}
      />
      <div
        style={{
          marginTop: 26,
          fontFamily: SERIF,
          fontSize: 22,
          letterSpacing: 2,
          color: 'rgba(238,231,216,0.72)',
          opacity: interpolate(frame, [fps * 1.2, fps * 1.8], [0, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          }),
        }}
      >
        从峡口到深泽
      </div>
    </AbsoluteFill>
  );
};

/** 结尾：一句话压住，再淡出 */
const EndCard: React.FC<{at?: number}> = ({at = 0}) => {
  const frame = useCurrentFrame();
  const {fps, durationInFrames} = useVideoConfig();
  const local = frame - at;
  return (
    <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center'}}>
      <div
        style={{
          fontFamily: SERIF,
          fontSize: 64,
          letterSpacing: 10,
          color: '#f5eee0',
          opacity: interpolate(local, [0, fps * 0.8, durationInFrames - at - 24, durationInFrames - at], [0, 1, 1, 0], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          }),
        }}
      >
        水路未尽
      </div>
    </AbsoluteFill>
  );
};

export const Edit: React.FC = () => {
  return (
    <AbsoluteFill style={{backgroundColor: '#080b0d'}}>
      <TransitionSeries>
        <TransitionSeries.Sequence durationInFrames={90}>
          <Plate file="clips/landmark-1.mp4" from={1.08} to={1.02} dim={0.58}>
            <TitleCard />
          </Plate>
        </TransitionSeries.Sequence>

        <TransitionSeries.Transition presentation={fade()} timing={linearTiming({durationInFrames: 14})} />

        <TransitionSeries.Sequence durationInFrames={110}>
          <Plate file="clips/landmark-1.mp4" startFrom={30} from={1.04} to={1.13}>
            <Caption index="01" name="荆门关" note="山地结束，泽国开始" />
          </Plate>
        </TransitionSeries.Sequence>

        <TransitionSeries.Transition
          presentation={slide({direction: 'from-right'})}
          timing={linearTiming({durationInFrames: 14})}
        />

        <TransitionSeries.Sequence durationInFrames={110}>
          <Plate file="clips/landmark-3.mp4" from={1.12} to={1.03}>
            <Caption index="02" name="无岸城 · 舵塔" note="石柱、木井架与铁索" />
          </Plate>
        </TransitionSeries.Sequence>

        <TransitionSeries.Transition presentation={fade()} timing={linearTiming({durationInFrames: 14})} />

        <TransitionSeries.Sequence durationInFrames={92}>
          <Plate file="clips/landmark-6.mp4" from={1.03} to={1.12} dim={0.18}>
            <Caption index="03" name="九歌台" note="祭水石坛，崖口升望" delay={4} exitAt={34} />
            <EndCard at={30} />
          </Plate>
        </TransitionSeries.Sequence>
      </TransitionSeries>
    </AbsoluteFill>
  );
};
