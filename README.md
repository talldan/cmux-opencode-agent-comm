# cmux-opencode-agent-comm

An [OpenCode](https://opencode.ai) plugin for agent-to-agent communication across [CMUX](https://cmux.com) workspaces. Lets multiple OpenCode agents send messages to each other, read each other's screen output, and discover each other — all mediated by the user.

## How it works

When you have multiple OpenCode instances running in different CMUX workspaces (or even the same workspace), this plugin lets them communicate. Each agent has a unique surface UUID assigned by CMUX. The user shares UUIDs between agents to establish communication.

```
┌─ Workspace: Gutenberg ────────┐    ┌─ Workspace: ~ ─────────────────┐
│                                │    │                                │
│  Agent A: "My UUID is          │    │  Agent B: "Sending message     │
│  718AFBDF-203C-..."            │    │  to 718AFBDF-203C-..."         │
│                                │    │                                │
│  [User copies UUID]  ──────────┼────┼─> [User pastes UUID]          │
│                                │    │                                │
└────────────────────────────────┘    └────────────────────────────────┘
```

The communication flow:

1. User asks agent A to `identify` — it returns its UUID and copies it to the clipboard
2. User pastes the UUID into agent B's chat
3. Agent B can now `send` messages to agent A using the UUID
4. Messages include the sender's UUID in a header, so replies work without another identify step

## Actions

| Action | Description |
|--------|-------------|
| `identify` | Return this agent's CMUX surface UUID and copy it to the clipboard. |
| `list` | Discover all other OpenCode agents across CMUX workspaces. |
| `send` | Send a message to another agent by surface UUID. Includes a header with the sender's UUID, cwd, and git branch. |
| `read` | Read the screen output of another agent's OpenCode surface by UUID. |

## Dependencies

- [OpenCode](https://opencode.ai) 1.3+
- [CMUX](https://cmux.com) 0.60+

## Installation

Add the plugin to your `opencode.json` configuration:

```json
{
  "plugin": ["cmux-opencode-agent-comm"]
}
```

This can go in your global config (`~/.config/opencode/opencode.json`) or a project-level config (`opencode.json` in your project root).

Restart OpenCode to load the plugin. The `agent_comm` tool will be available to the AI agent automatically.

## Usage

### Identify (share your UUID)

Ask the agent: *"What's your surface ID?"* or *"Identify yourself"*

The agent calls `identify`, which returns the CMUX surface UUID and copies it to your clipboard. Paste it into another agent's chat to let them target this agent.

### Send a message

Ask the agent: *"Send a message to \<paste UUID\>"*

The agent calls `send` with the target UUID and your message. Messages are prefixed with a header containing the sender's UUID, working directory, and git branch:

```
[From 4B5B07D2-DF26-4AB9-852C-D0D8C11A0FD1, ~/code/dotfiles:main] Your message here
```

The receiving agent can extract the sender's UUID from the header to reply.

### Read another agent's screen

Ask the agent: *"Read the screen of \<paste UUID\>"*

The agent calls `read` with the target UUID and returns the raw screen content (including scrollback). This is useful for checking what another agent is doing or what it last said.

### List other agents

Ask the agent: *"List other agents"*

The agent calls `list`, which scans all CMUX workspaces for other OpenCode instances. This is useful for discovering agents but doesn't return UUIDs — ask the target agent to `identify` for that.

## Design

### Architecture

```
Agent A (OpenCode)                  CMUX                        Agent B (OpenCode)
      │                               │                              │
      │  cmux send --surface <UUID>   │                              │
      │  "message text"               │                              │
      │ ─────────────────────────────>│  types text into surface     │
      │                               │ ────────────────────────────>│
      │                               │                              │
      │  cmux read-screen             │                              │
      │  --surface <UUID>             │                              │
      │ ─────────────────────────────>│  reads terminal buffer       │
      │                               │ ────────────────────────────>│
      │  screen content               │                              │
      │ <─────────────────────────────│                              │
```

The plugin uses the CMUX CLI to communicate between surfaces. `cmux send` types text into a target surface's terminal input, and `cmux read-screen` reads the terminal buffer of a target surface.

Key design decisions:

- **User-initiated only**: The tool description explicitly instructs the agent to never proactively send messages. Communication only happens when the user asks for it, preventing runaway agent-to-agent chatter.
- **UUID-based targeting**: Each CMUX surface has a unique UUID (`$CMUX_SURFACE_ID`). This avoids ambiguity when multiple OpenCode instances are in the same workspace — workspace names aren't unique enough for targeting.
- **Sender identity in headers**: Every sent message includes `[From <UUID>, <cwd>:<branch>]` so the receiver knows who sent it and can reply directly using the UUID.
- **Newline stripping**: `cmux send` interprets newlines as Enter keypresses, which would prematurely submit the message in OpenCode's input. All newlines are replaced with spaces before sending.
- **Screen reading for responses**: Rather than building a structured response channel, the plugin uses `cmux read-screen` to read raw terminal output. This is "noisy" (includes UI chrome) but the receiving LLM handles it well and it avoids any complex response coordination.
- **Discovery via screen scanning**: The `list` action finds other OpenCode instances by reading the last few lines of every terminal surface and checking for the "OpenCode" signature in the status bar. This works regardless of surface naming.

## Future improvements

### Structured response channel

Currently, reading another agent's response requires `cmux read-screen` which returns raw terminal output including UI elements. A structured channel (e.g., via files or a shared socket) could provide cleaner response data.

### Improved discovery of surfaces

The `list` action discovers agents but can only return CMUX surface refs (e.g., `surface:38`), not UUIDs. A mechanism to resolve surface refs to UUIDs without user mediation would make fully automated discovery possible.
