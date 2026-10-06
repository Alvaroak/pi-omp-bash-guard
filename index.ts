/**
 * Bash guard extension.
 *
 * Confirms before running bash commands that match a curated list of
 * destructive patterns (recursive/force rm, sudo, permission bombs, force
 * pushes, disk-level writes, piped-to-shell downloads, fork bombs). On by
 * default; toggle with /bash-guard, state persists across resumes.
 *
 * Subagents run headlessly with no UI to confirm against, so a dangerous
 * command from a subagent is blocked outright rather than prompted — same
 * rule the hosts' own permission-gate example applies.
 *
 * Publishes state changes over pi.events ("bash-guard:changed") for
 * the power-footer extensions to render the 🛡️ shield flag (green on, red
 * off) next to the frugal flag.
 */

// Shared by omp and pi. Types come from omp's package (erased at runtime); the TUI helpers
// are imported from the host's own pi-tui when the confirm overlay opens.
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

/** Both hosts' pi-tui builds export these names with identical runtime behavior — only
 *  their classes are distinct types, so the loaded module is cast to this structural shape. */
interface TuiHelpers {
	Container: new () => { addChild(child: unknown): void; render(width: number): string[]; invalidate(): void };
	Spacer: new (lines: number) => unknown;
	Text: new (text: string, padLeft?: number, padRight?: number) => { setText(text: string): void; render(width: number): string[] };
	Key: { enter: string; escape: string } & Record<string, unknown>;
	matchesKey(data: string, key: string): boolean;
	truncateToWidth(text: string, maxWidth: number, ellipsis: string, pad?: boolean): string;
	visibleWidth(text: string): number;
	wrapTextWithAnsi(text: string, maxWidth: number): string[];
}

let K: TuiHelpers;

/** omp's ExtensionAPI has a `logger`; pi's does not. */
const isOmp = (pi: ExtensionAPI) => "logger" in pi;

interface BashGuardState {
	enabled: boolean;
}

/** omp's Theme always has getThinkingBorderColor; pi's does not. */
interface MinimalTheme {
	getThinkingBorderColor?(level: string): (text: string) => string;
	fg(color: string, text: string): string;
	bold(text: string): string;
}

function createBashGuardConfirmComponent(command: string, label: string, border: (s: string) => string) {
	return (
		tui: { requestRender(): void },
		theme: MinimalTheme,
		_kb: unknown,
		done: (result: "allow" | "deny") => void,
	) => {
		const container = new K.Container();

		container.addChild(new K.Text(theme.fg("error", theme.bold("Dangerous Command Detected")), 1, 0));
		container.addChild(new K.Spacer(1));
		container.addChild(new K.Text(theme.fg("warning", `This command contains ${label}:`), 1, 0));
		container.addChild(new K.Spacer(1));
		const commandText = new K.Text("", 1, 0);
		container.addChild(commandText);
		container.addChild(new K.Spacer(1));
		container.addChild(new K.Text(theme.fg("text", "Allow execution?"), 1, 0));
		container.addChild(new K.Spacer(1));
		container.addChild(new K.Text(theme.fg("dim", "y/enter: allow • n/esc: deny"), 1, 0));

		return {
			render: (width: number) => {
				// ctx.ui.custom's overlay positions this component, but does not add a
				// frame. Render one here so the modal has visible side borders and
				// consistent horizontal/vertical breathing room.
				const innerWidth = Math.max(1, width - 4);
				commandText.setText(K.wrapTextWithAnsi(theme.fg("text", command), Math.max(1, innerWidth - 2)).join("\n"));
				const wrap = (line: string) => {
					const content = K.truncateToWidth(line, innerWidth, "");
					const pad = " ".repeat(Math.max(0, innerWidth - K.visibleWidth(content)));
					return `${border("│")} ${content}${pad} ${border("│")}`;
				};
				const top = border(`┌${"─".repeat(Math.max(1, width - 2))}┐`);
				const bottom = border(`└${"─".repeat(Math.max(1, width - 2))}┘`);
				return [top, wrap(""), ...container.render(innerWidth).map(wrap), wrap(""), bottom];
			},
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				if (K.matchesKey(data, K.Key.enter) || data === "y" || data === "Y") {
					done("allow");
				} else if (K.matchesKey(data, K.Key.escape) || data === "n" || data === "N") {
					done("deny");
				}
				tui.requestRender();
			},
		};
	};
}

const DANGEROUS_PATTERNS: { pattern: RegExp; label: string }[] = [
	{ pattern: /\brm\s+(-[a-z]*[rf][a-z]*\s+.*-[a-z]*[rf][a-z]*|-(-recursive|-force)\b|-[a-z]*[rf]{2}[a-z]*\b)/i, label: "recursive/force delete" },
	{ pattern: /\bsudo\b/i, label: "sudo" },
	{ pattern: /\b(chmod|chown)\b.*(-R\b.*\b777\b|\b777\b.*-R\b|\b777\b)/i, label: "permission bomb (777)" },
	{ pattern: /\bgit\s+push\b.*(--force\b|-f\b)/i, label: "force push" },
	{ pattern: /\bdd\b.*\bof=\/dev\//i, label: "raw disk write" },
	{ pattern: /\bmkfs(\.\w+)?\b/i, label: "filesystem format" },
	{ pattern: />\s*\/dev\/sd[a-z]\b/i, label: "raw disk write" },
	{ pattern: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba)?sh\b/i, label: "curl|sh install" },
	{ pattern: /:\(\)\s*\{\s*:\|:&\s*\};:/, label: "fork bomb" },
];

function findMatch(command: string): string | undefined {
	for (const { pattern, label } of DANGEROUS_PATTERNS) {
		if (pattern.test(command)) return label;
	}
	return undefined;
}

export default function bashGuardExtension(pi: ExtensionAPI): void {
	let enabled = true;

	function persistState(): void {
		pi.appendEntry("bash-guard-state", { enabled } satisfies BashGuardState);
	}

	function publish(): void {
		pi.events.emit("bash-guard:changed", { enabled });
	}

	pi.registerCommand("bash-guard", {
		description: "Toggle the bash guard (confirmation before destructive commands)",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			persistState();
			publish();
			ctx.ui.notify(enabled ? "Bash guard enabled." : "Bash guard disabled.", "info");
		},
	});

	pi.on("tool_call", async (event, ctx: ExtensionContext) => {
		if (!enabled) return undefined;
		if (event.toolName !== "bash") return undefined;

		const command = event.input.command as string;
		const match = findMatch(command);
		if (!match) return undefined;

		if (!ctx.hasUI) {
			// Subagents and other headless callers get no confirmation prompt,
			// so block outright rather than let a destructive command through.
			return { block: true, reason: `Bash guard: blocked "${match}" (no UI for confirmation)` };
		}

		// The Herdr state bridge turns this into a blocked/red agent state and
		// raises Herdr's normal attention notification for a blocked pane.
		pi.events.emit("herdr:blocked", { active: true, label: `Bash guard: ${match}` });

		if (!K) {
			const host_tui = await (isOmp(pi) ? import("@oh-my-pi/pi-tui") : import("@earendil-works/pi-tui"));
			K = host_tui as unknown as TuiHelpers;
		}
		const theme = ctx.ui.theme as unknown as MinimalTheme;
		const border = isOmp(pi)
			? theme.getThinkingBorderColor!(pi.getThinkingLevel() ?? "off")
			: (s: string) => theme.fg("error", s);
		let choice: "allow" | "deny";
		try {
			choice = await ctx.ui.custom(
				createBashGuardConfirmComponent(command, match, border),
				{
					overlay: true,
					overlayOptions: {
						anchor: "center",
						width: "70%",
						maxHeight: "70%",
						margin: 2,
					},
				},
			);
		} finally {
			pi.events.emit("herdr:blocked", { active: false });
		}

		if (choice !== "allow") {
			return { block: true, reason: "Blocked by user" };
		}

		return undefined;
	});

	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries();
		const last = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "bash-guard-state")
			.pop() as { data?: BashGuardState } | undefined;

		if (last?.data) {
			enabled = last.data.enabled;
		}
		publish();
	});
}
