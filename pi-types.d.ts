declare module "@earendil-works/pi-coding-agent" {
	export interface ToolDefinition {
		name: string;
		description: string;
		parameters: unknown;
		sourceInfo?: {
			path: string;
			source: "builtin" | "sdk" | "extension";
			scope: "user" | "project" | "temporary";
			origin: "package" | "top-level";
		};
	}

	export interface UI {
		notify(message: string, level: "info" | "warning" | "error"): void;
		confirm(
			title: string,
			message: string,
			options?: { timeout?: number; signal?: AbortSignal },
		): Promise<boolean>;
		input(title: string, placeholder?: string): Promise<string | undefined>;
		select(title: string, options: string[]): Promise<string | undefined>;
		setStatus(id: string, text: string | undefined): void;
	}

	export interface ExtensionContext {
		ui: UI;
		cwd: string;
		mode: "tui" | "rpc" | "json" | "print";
		hasUI: boolean;
		signal: AbortSignal | undefined;
		sessionManager: {
			getEntries(): unknown[];
			getSessionFile(): string | null;
		};
	}

	export interface ToolCallEvent {
		toolName: string;
		toolCallId: string;
		input: unknown;
	}

	export interface BeforeAgentStartEvent {
		systemPrompt: string;
		prompt: string;
	}

	export type ToolCallHandler = (
		event: ToolCallEvent,
		ctx: ExtensionContext,
	) => void | undefined | { block: true; reason?: string };

	export type BeforeAgentStartHandler = (
		event: BeforeAgentStartEvent,
		ctx: ExtensionContext,
	) => void | undefined | { systemPrompt?: string; message?: unknown };

	export type SessionStartHandler = (
		event: unknown,
		ctx: ExtensionContext,
	) => void | undefined | Promise<void>;

	export type CommandHandler = (
		args: string | undefined,
		ctx: ExtensionContext,
	) => void | Promise<void>;

	export interface CommandDefinition {
		description: string;
		handler: CommandHandler;
	}

	export interface ExtensionAPI {
		on(
			event: "tool_call",
			handler: (
				event: ToolCallEvent,
				ctx: ExtensionContext,
			) => void | undefined | { block: true; reason?: string },
		): void;
		on(event: "before_agent_start", handler: BeforeAgentStartHandler): void;
		on(event: "session_start", handler: SessionStartHandler): void;
		on(event: string, handler: (...args: any[]) => any): void;
		getAllTools(): ToolDefinition[];
		setActiveTools(names: string[]): void;
		registerCommand(name: string, definition: CommandDefinition): void;
	}
}
