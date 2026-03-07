export type ChatRole = "system" | "user" | "assistant" | "tool";

export type ApprovalScope = "once" | "session" | "deny";
export type ReasoningEffort = "low" | "medium" | "high";

export interface ToolCallFunction {
  name: string;
  arguments: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: ToolCallFunction;
}

export interface ChatMessage {
  role: ChatRole;
  content: string | null;
  tool_calls?: ToolCall[] | null;
  tool_call_id?: string;
}

export interface PersistedMessage extends ChatMessage {
  timestamp: string;
}

export interface ApprovalEvent {
  kind: ApprovalKind;
  scope: Exclude<ApprovalScope, "deny">;
  key: string;
  label: string;
  timestamp: string;
}

export interface SessionApprovals {
  sessionActionKeys: string[];
  outOfTreeRoots: string[];
  webAccess: boolean;
}

export interface SessionState {
  id: string;
  workspaceRoot: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  approvals: SessionApprovals;
  messages: PersistedMessage[];
  referencedFiles: string[];
  readFiles: string[];
  pinnedSkills: string[];
}

export interface SessionListItem {
  id: string;
  workspaceRoot: string;
  model: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionMetaRecord {
  type: "meta";
  id: string;
  workspaceRoot: string;
  model: string;
  createdAt: string;
}

export interface SessionMessageRecord {
  type: "message";
  timestamp: string;
  message: PersistedMessage;
}

export interface SessionApprovalRecord {
  type: "approval";
  approval: ApprovalEvent;
}

export interface SessionReferenceRecord {
  type: "reference";
  path: string;
  timestamp: string;
}

export interface SessionReadRecord {
  type: "read";
  path: string;
  timestamp: string;
}

export interface SessionModelRecord {
  type: "model";
  model: string;
  timestamp: string;
}

export interface SessionSkillRecord {
  type: "skill";
  action: "pin" | "unpin" | "clear";
  skillName?: string;
  timestamp: string;
}

export type SessionRecord =
  | SessionMetaRecord
  | SessionMessageRecord
  | SessionApprovalRecord
  | SessionReferenceRecord
  | SessionReadRecord
  | SessionModelRecord
  | SessionSkillRecord;

export interface FileConfig {
  defaultModel?: string;
  reasoningEffort?: ReasoningEffort | null;
  baseUrl?: string;
  searchProvider?: {
    name?: string;
  };
  trustedWorkspaces?: string[];
  savedAuth?: {
    mode: "bearer" | "subscription_key";
    sha256: string;
    value?: string;
  };
}

export type AuthSource = "env" | "session" | "stored" | "stored_hash" | "missing";

export interface EffectiveConfig {
  authMode: "bearer" | "subscription_key" | "missing";
  authValue: string | undefined;
  authFingerprint: string | undefined;
  authSource: AuthSource;
  baseUrl: string;
  defaultModel: string;
  reasoningEffort: ReasoningEffort | null;
  configPath: string;
  dataPath: string;
  searchProviderName: string;
  trustedWorkspaces: string[];
}

export type ApprovalKind =
  | "path_access"
  | "write_file"
  | "replace_in_file"
  | "run_shell"
  | "web_access";

export interface ApprovalRequest {
  kind: ApprovalKind;
  key: string;
  label: string;
}

export interface ToolExecutionSummary {
  toolName: string;
  summary: string;
  referencedFiles?: string[];
}

export interface ToolResult {
  summary: string;
  content: string;
  isError: boolean;
  referencedFiles?: string[];
  readFiles?: string[];
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchProvider {
  readonly name: string;
  readonly configured: boolean;
  search(query: string, limit: number): Promise<SearchResult[]>;
}

export interface ToolContext {
  cwd: string;
  workspaceRoot: string;
  approvals: {
    requestApproval(request: ApprovalRequest): Promise<boolean>;
    hasSessionGrant(key: string): boolean;
    registerReference(path: string): Promise<void>;
    ensureWebAccess(): Promise<boolean>;
  };
  reads: {
    hasRead(path: string): boolean;
    registerRead(path: string): Promise<void>;
  };
  paths: {
    resolve(inputPath: string): string;
    ensureReadable(inputPath: string): Promise<string>;
    ensureWritable(inputPath: string): Promise<string>;
    allowedRoots(): string[];
  };
  searchProvider: SearchProvider;
}

export interface ToolSpec {
  name: string;
  description: string;
  jsonSchema: Record<string, unknown>;
  readOnly: boolean;
  execute(rawArgs: unknown, context: ToolContext): Promise<ToolResult>;
}

export interface SarvamToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface SarvamChatCompletionRequest {
  messages: ChatMessage[];
  model: string;
  stream?: boolean;
  temperature?: number;
  reasoning_effort?: ReasoningEffort | null;
  tools?: SarvamToolDefinition[];
  tool_choice?: "none" | "auto" | "required";
}

export interface SarvamChatCompletionMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: ToolCall[] | null;
}

export interface SarvamChatCompletionResponse {
  id: string;
  model: string;
  choices: Array<{
    finish_reason: string;
    index: number;
    message: SarvamChatCompletionMessage;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  } | null;
}

export interface SarvamStreamDeltaToolCall {
  index: number;
  id?: string;
  type?: "function";
  function?: {
    name?: string;
    arguments?: string;
  };
}

export interface SarvamStreamChunk {
  id?: string;
  choices?: Array<{
    index: number;
    finish_reason?: string | null;
    delta?: {
      role?: "assistant";
      content?: string | null;
      tool_calls?: SarvamStreamDeltaToolCall[];
    };
  }>;
}

export interface StreamedAssistantTurn {
  content: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
}
