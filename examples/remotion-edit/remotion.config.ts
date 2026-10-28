import {Config} from '@remotion/cli/config';

// 镜头是给 filmbench 编译用的：jpeg 中间帧够用又快，成片仍是 h264
Config.setVideoImageFormat('jpeg');
Config.setConcurrency(6);
Config.setOverwriteOutput(true);
