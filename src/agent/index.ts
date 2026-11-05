/**
 * index.ts — `src/agent/` 的对外入口。
 *
 * 这一层是 agent（MCP 客户端 / 编码 agent）的**唯一操作面**，装配在 `main.ts`：
 * 把 `appState` 包成 `ControlContext`，再挂到 `window.__artmatic.control`。
 * 这样 `ui/` 之上的东西不必知道 agent 存在（方案 §2.2）。
 *
 * 依赖方向（方案 §2.2）：`src/agent/` 依赖 `{ core, engine, exporters, effects,
 * algos }`，**不依赖 `ui/`** —— 运行期实例全部走注入的 `ControlContext`。
 * 将来 `/lab/` 或独立入口想复用控制平面时不会成环。
 */

export { createControlPlane, type AgentControlPlane } from './control-plane';
export { getCapabilities, getTypographyCapabilities } from './capabilities';
export { buildSceneSnapshot, buildClipView, snapToFrame, visualZ } from './scene';
export { makeEffectClip, makeSourceClip, type EffectClipInput, type SourceClipInput } from './clip-factory';
export { frameSignatureOf, type SignatureInput } from './frame-signature';
export { pluginReference, helpText, HELP_TOPICS, type HelpTopic } from './plugin-spec';
export { CONTROL_API_VERSION, ControlFailure } from './types';
export type {
  AgentPluginHost,
  Capabilities,
  CapabilityDetail,
  ClipSourceView,
  ClipTextSummary,
  ClipView,
  ControlContext,
  ControlErrorCode,
  ControlResult,
  DescribeInfo,
  EffectCapability,
  ExportArtifact,
  ExportArtifactBase64,
  ExportFormat,
  ExportRequest,
  ExportState,
  FrameSignature,
  GeneratorCapability,
  OpenProjectView,
  ParamSchema,
  PluginCheckView,
  PluginEditResult,
  PluginGrepResult,
  PluginInfoView,
  PluginTryResult,
  PluginViewResult,
  RenderOnly,
  SceneDetail,
  SceneSnapshot,
  SceneVersion,
  TransitionCapability,
  TypographyCapabilities,
  TypographyDocIdView,
  TypographyDocView,
  TypographyElementInput,
  TypographyElementPatch,
  TypographyElementUpdate,
  TypographyElementView,
  TypographyLayoutRequest,
  TypographyMeasure,
  UndoState,
} from './types';
