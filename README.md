# @alvaroak/pi-omp-bash-guard

Confirmation gate for destructive bash commands. One file, runs on both **omp** and **pi**.

Before a matching command runs, you get a confirm prompt. Patterns cover recursive/force `rm`, `sudo`, permission bombs, force pushes, disk-level writes, piped-to-shell downloads, and fork bombs.

Subagents run headlessly with no UI to confirm against, so a dangerous command from a subagent is **blocked outright** rather than prompted.

State changes are published over `pi.events` (`bash-guard:changed`) so other extensions (e.g. a power footer) can render the shield flag.

> Adapted from [amosblomqvist/pi-config](https://github.com/amosblomqvist/pi-config) (`extensions/bash-guard`).

## Host differences (all in `index.ts`)
| | omp | pi |
|---|---|---|
| Detect | `"logger" in pi` | otherwise |
| Confirm border color | `theme.getThinkingBorderColor(pi.getThinkingLevel())` | hardcoded `theme.fg("error")` |
| TUI helpers | `@oh-my-pi/pi-tui` | `@earendil-works/pi-tui` (dynamic import on confirm) |

## Install

```bash
pi install git:github.com/Alvaroak/pi-omp-bash-guard@v0.3.0
```

- omp: symlink into `~/.omp/agent/extensions/pi-omp-bash-guard`.
- pi: settings.json git package pinned to the release tag.

## Usage

On by default. Toggle with `/bash-guard` — state persists across session resumes.

## License

MIT
