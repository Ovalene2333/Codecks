import type { DeckTool, ToolDescriptor } from "../server-registry.js";

/**
 * deck-api 协作泳道是纯前端示例页：数据在 shared/deck-api-swimlanes.json，
 * 页面只做展示和命令复制，不需要服务端动作。
 */
export class DeckApiTool implements DeckTool {
  descriptor(): ToolDescriptor {
    return {
      id: "deck-api",
      name: "协作泳道",
      description: "用泳道图查看 deck-api 的委派、steer、wake 与 detached 真实案例",
      icon: "waypoints",
      available: true,
      pagePath: "/deck-api",
    };
  }
}
