import type { DeckTool, ToolDescriptor } from "../server-registry.js";

/**
 * deck-api 协作泳道由 GET /api/deck/lanes 从本机询问台账解析；
 * 静态快照在 shared/deck-api-swimlane-example.json，页面只做展示。
 */
export class DeckApiTool implements DeckTool {
  descriptor(): ToolDescriptor {
    return {
      id: "deck-api",
      name: "协作泳道",
      description: "解析本机询问台账，用泳道图查看委派、补充、唤醒与 detached",
      icon: "waypoints",
      available: true,
      pagePath: "/deck-api",
    };
  }
}
