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
