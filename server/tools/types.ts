import type { WebSocket } from "ws";

export interface ToolDescriptor {
  id: string;
  name: string;
  description: string;
  icon: string;
  available: boolean;
  unavailableReason?: string;
  pagePath?: string;
  defaultCwd?: string;
}

export interface DeckTool {
  descriptor(): ToolDescriptor;
  run?(input: Record<string, unknown>): Promise<unknown>;
  connect?(socket: WebSocket): void;
  close?(): void;
}

export class ToolRegistry {
  private tools = new Map<string, DeckTool>();

  constructor(tools: DeckTool[] = []) {
    for (const tool of tools) this.register(tool);
  }

  register(tool: DeckTool) {
    const id = tool.descriptor().id;
    if (this.tools.has(id)) throw new Error(`工具 ${id} 已注册`);
    this.tools.set(id, tool);
  }

  list() {
    return [...this.tools.values()].map((tool) => tool.descriptor());
  }

  async run(id: string, input: Record<string, unknown>) {
    const tool = this.tools.get(id);
    if (!tool) throw new Error("工具不存在");
    const descriptor = tool.descriptor();
    if (!descriptor.available)
      throw new Error(descriptor.unavailableReason || "工具当前不可用");
    if (!tool.run) throw new Error("工具不支持此操作");
    return tool.run(input);
  }

  connect(id: string, socket: WebSocket) {
    const tool = this.tools.get(id);
    if (!tool?.connect) throw new Error("工具不支持实时连接");
    const descriptor = tool.descriptor();
    if (!descriptor.available)
      throw new Error(descriptor.unavailableReason || "工具当前不可用");
    tool.connect(socket);
  }

  close() {
    for (const tool of this.tools.values()) tool.close?.();
  }
}
