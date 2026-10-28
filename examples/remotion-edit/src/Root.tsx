import {Composition} from 'remotion';
import {Edit, EDIT_FRAMES} from './Edit';

/**
 * 一个"剪辑"composition：三段素材、两次交叉溶解、一次推镜接上，
 * 字幕与片名是 React 动画，不是烧进素材的字。
 *
 * 输出尺寸/帧率与 filmbench 项目格式一致（1280×720@30），
 * 这样 provider 渲染出来的产物能直接进编译。
 */
export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="Edit"
      component={Edit}
      durationInFrames={EDIT_FRAMES}
      fps={30}
      width={1280}
      height={720}
      defaultProps={{}}
    />
  );
};
