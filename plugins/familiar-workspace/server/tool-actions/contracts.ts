export interface ToolActionParameter {
  key: string;
  label: string;
  required?: boolean;
  description?: string;
}

export interface ToolActionDefinition {
  id: string;
  label: string;
  description: string;
  input?: boolean;
  inputMode?: "prompt" | "command" | "data";
  nativeId?: boolean;
  mutates?: boolean;
  parameters?: ToolActionParameter[];
}

export interface ToolActionRequest {
  toolId: string;
  action: string;
  cwd: string;
  sessionId: string;
  input: string;
  nativeId?: string;
  parameters: Record<string, string>;
}

export interface ToolCommand {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface ToolHttpRequest {
  url: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "PROPFIND" | "MKCOL";
  headers?: Record<string, string>;
  body?: unknown;
  socketPath?: string;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface ToolActionContext {
  runDirectory: string;
  signal: AbortSignal;
  resolveCommand(command: string): Promise<string>;
  nativeContext?(toolId: string): Promise<{ args: string[]; env: Record<string, string> }>;
  exec(command: ToolCommand): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  request(request: ToolHttpRequest): Promise<{ status: number; body: string }>;
}

export interface ToolActionResult {
  state: "completed" | "submitted";
  text: string;
  nativeId?: string;
  artifacts?: { path: string; label: string }[];
}

/** The native tool owns execution, permissions and orchestration; this adapter only invokes its public surface. */
export interface ToolActionAdapter {
  id: string;
  actions: ToolActionDefinition[];
  execute(request: ToolActionRequest, context: ToolActionContext): Promise<ToolActionResult>;
}
