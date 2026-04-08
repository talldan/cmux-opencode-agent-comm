import { type Plugin, tool } from "@opencode-ai/plugin"

/**
 * Run a cmux CLI command and return stdout.
 */
const cmux = async (...args: string[]): Promise<string> => {
  const result = await Bun.$`cmux ${args}`.text()
  return result.trim()
}

/**
 * Get the caller's CMUX surface UUID from the environment.
 */
const getOwnUUID = (): string | undefined => process.env.CMUX_SURFACE_ID

/**
 * Parse workspace list output into [{ref, name}].
 */
const parseWorkspaces = (output: string): { ref: string; name: string }[] => {
  const results: { ref: string; name: string }[] = []
  for (const line of output.split("\n")) {
    const match = line.match(/(workspace:\d+)\s+(.+?)(?:\s+\[selected\])?\s*$/)
    if (match) results.push({ ref: match[1], name: match[2].trim() })
  }
  return results
}

/**
 * Parse pane list output into pane refs.
 */
const parsePanes = (output: string): string[] => {
  const results: string[] = []
  for (const line of output.split("\n")) {
    const match = line.match(/(pane:\d+)/)
    if (match) results.push(match[1])
  }
  return results
}

/**
 * Parse surface list output into [{ref, name}].
 */
const parseSurfaces = (output: string): { ref: string; name: string }[] => {
  const results: { ref: string; name: string }[] = []
  for (const line of output.split("\n")) {
    const match = line.match(/(surface:\d+)\s+(.+?)(?:\s+\[selected\])?\s*$/)
    if (match) results.push({ ref: match[1], name: match[2].trim() })
  }
  return results
}

/**
 * Parse a composite surface identifier (ws:N/uuid:XXXX) into workspace ref and surface UUID.
 * Falls back to treating the input as a bare UUID if it doesn't match the composite format.
 */
const parseCompositeId = (id: string): { workspace?: string; surface: string } => {
  const match = id.match(/^ws:(\d+)\/uuid:(.+)$/)
  if (match) return { workspace: `workspace:${match[1]}`, surface: match[2] }
  return { surface: id }
}

/**
 * Check if a surface is running OpenCode by reading its status bar.
 */
const isOpenCodeSurface = async (
  workspaceRef: string,
  surfaceRef: string
): Promise<boolean> => {
  try {
    const screen = await cmux(
      "read-screen",
      "--workspace", workspaceRef,
      "--surface", surfaceRef,
      "--lines", "3"
    )
    return screen.includes("OpenCode")
  } catch {
    return false
  }
}

interface AgentInfo {
  workspace_name: string
  surface_ref: string
}

/**
 * Discover all OpenCode instances across CMUX workspaces,
 * excluding the caller's own surface.
 */
const discoverAgents = async (): Promise<AgentInfo[]> => {
  const agents: AgentInfo[] = []
  const ownRef = await getOwnSurfaceRef()
  const workspaces = parseWorkspaces(await cmux("list-workspaces"))

  for (const ws of workspaces) {
    const panes = parsePanes(await cmux("list-panes", "--workspace", ws.ref))

    for (const paneRef of panes) {
      const surfaces = parseSurfaces(
        await cmux("list-pane-surfaces", "--workspace", ws.ref, "--pane", paneRef)
      )

      for (const surface of surfaces) {
        if (ownRef && surface.ref === ownRef) continue
        if (await isOpenCodeSurface(ws.ref, surface.ref)) {
          agents.push({
            workspace_name: ws.name,
            surface_ref: surface.ref,
          })
        }
      }
    }
  }

  return agents
}

/**
 * Get the caller's own surface ref (surface:N) from cmux identify.
 */
const getOwnSurfaceRef = async (): Promise<string | undefined> => {
  try {
    const raw = await cmux("identify")
    const parsed = JSON.parse(raw)
    return parsed?.caller?.surface_ref
  } catch {
    return undefined
  }
}

/**
 * Get the caller's own composite identity (UUID + workspace ref).
 */
const getOwnIdentity = async (): Promise<{ uuid: string; workspaceRef: string } | undefined> => {
  const uuid = getOwnUUID()
  if (!uuid) return undefined
  try {
    const raw = await cmux("identify")
    const parsed = JSON.parse(raw)
    const wsRef = parsed?.caller?.workspace_ref
    if (!wsRef) return undefined
    return { uuid, workspaceRef: wsRef }
  } catch {
    return undefined
  }
}

/**
 * Build a composite surface identifier from a workspace ref and UUID.
 * Format: ws:N/uuid:XXXX
 */
const buildCompositeId = (workspaceRef: string, uuid: string): string => {
  const wsNum = workspaceRef.replace("workspace:", "")
  return `ws:${wsNum}/uuid:${uuid}`
}

export const AgentCommPlugin: Plugin = async (ctx) => {
  return {
    tool: {
      agent_comm: tool({
        description:
          "Communicate with other OpenCode agents running in different CMUX workspaces.\n\n" +
          "IMPORTANT: This tool is for USER-INITIATED communication only.\n" +
          "- NEVER proactively send messages to other agents\n" +
          "- Only use 'send' when the user explicitly asks you to communicate with another agent\n" +
          "- After sending, tell the user the message was sent and WAIT — do not auto-read the response\n" +
          "- Only use 'read' when the user asks you to check what the other agent said\n\n" +
          "Actions:\n" +
          "- identify: Return your own CMUX surface identifier (ws:N/uuid:XXXX format) and copy it to clipboard. " +
          "Use when the user asks 'who are you?' or wants your identity for another agent.\n" +
          "- list: Discover all other OpenCode agents across CMUX workspaces.\n" +
          "- send: Send a message to another agent by surface identifier.\n" +
          "- read: Read the screen of another agent's OpenCode surface by identifier.",
        args: {
          action: tool.schema
            .enum(["identify", "list", "send", "read"])
            .describe(
              "identify: return this agent's surface identifier. " +
              "list: discover other OpenCode agents. " +
              "send: send message to agent by surface identifier. " +
              "read: read another agent's screen output by surface identifier."
            ),
          surface: tool.schema
            .string()
            .optional()
            .describe("Target surface identifier in ws:N/uuid:XXXX format (required for send and read). Get this from the user — they paste it from the other agent's 'identify' output."),
          message: tool.schema
            .string()
            .optional()
            .describe("Message to send (required for send). Newlines will be replaced with spaces."),
          lines: tool.schema
            .number()
            .optional()
            .describe("Number of scrollback lines to read (read only, default 50)."),
        },
        async execute(args, context) {
          try {
            switch (args.action) {
              case "identify": {
                const identity = await getOwnIdentity()
                if (!identity) {
                  return "Could not determine surface identity. Is this running inside CMUX?"
                }

                const compositeId = buildCompositeId(identity.workspaceRef, identity.uuid)

                // Copy composite ID to clipboard
                try {
                  await Bun.$`printf '%s' ${compositeId} | pbcopy`
                } catch {}

                return `${compositeId}\n(Copied to clipboard)`
              }

              case "list": {
                const agents = await discoverAgents()

                if (agents.length === 0) {
                  return "No other OpenCode agents found in any CMUX workspace."
                }

                const lines = agents.map(
                  (a, i) => `  ${i + 1}. "${a.workspace_name}" (${a.surface_ref})`
                )

                return `Found ${agents.length} other OpenCode agent(s):\n${lines.join("\n")}\n\n` +
                  "Ask the target agent to 'identify' to get its UUID for send/read."
              }

              case "send": {
                if (!args.surface) {
                  return "Error: 'surface' identifier is required for send. " +
                    "Ask the user to paste the target agent's identifier (from its 'identify' output)."
                }
                if (!args.message) {
                  return "Error: 'message' is required for send."
                }

                const target = parseCompositeId(args.surface)
                const wsArgs = target.workspace ? ["--workspace", target.workspace] : []

                // Build sender identity header with our composite ID
                const senderIdentity = await getOwnIdentity()
                const senderId = senderIdentity
                  ? buildCompositeId(senderIdentity.workspaceRef, senderIdentity.uuid)
                  : (getOwnUUID() ?? "unknown")
                const senderCwd = process.cwd().replace(/^\/Users\/[^/]+/, "~")
                let senderBranch = ""
                try { senderBranch = (await Bun.$`git branch --show-current`.text()).trim() } catch {}
                const senderHeader = `[From ${senderId}, ${senderCwd}${senderBranch ? ":" + senderBranch : ""}]`

                // Strip newlines — they cause premature submission in OpenCode's input
                const cleanMessage = `${senderHeader} ${args.message}`.replace(/\n/g, " ")

                await cmux("send", ...wsArgs, "--surface", target.surface, cleanMessage)
                await cmux("send-key", ...wsArgs, "--surface", target.surface, "enter")

                return `Message sent to surface ${args.surface}.`
              }

              case "read": {
                if (!args.surface) {
                  return "Error: 'surface' identifier is required for read. " +
                    "Ask the user to paste the target agent's identifier (from its 'identify' output)."
                }

                const target = parseCompositeId(args.surface)
                const wsArgs = target.workspace ? ["--workspace", target.workspace] : []
                const numLines = args.lines ?? 50
                const screen = await cmux(
                  "read-screen",
                  ...wsArgs,
                  "--surface", target.surface,
                  "--scrollback",
                  "--lines", String(numLines)
                )

                return `Screen output from surface ${args.surface} (last ${numLines} lines):\n\n${screen}`
              }
            }
          } catch (e: any) {
            return `agent_comm error: ${e.message ?? e}`
          }
        },
      }),
    },
  }
}
