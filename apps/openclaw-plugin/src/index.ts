import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

type ClawHqConfig = {
  workspaceRoot?: string;
};

const PLUGIN_ID = "clawhq";
const PLUGIN_VERSION = "0.0.1";

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Claw HQ",
  description:
    "Project-scoped chats, sub-project task toggles, file uploads, cross-device live feed.",
  register(api) {
    const config = (api.pluginConfig ?? {}) as ClawHqConfig;
    const workspaceRoot =
      config.workspaceRoot ?? process.env.CLAWHQ_WORKSPACE_ROOT ?? null;

    api.logger.info(
      `clawhq plugin loaded (version=${PLUGIN_VERSION}, workspaceRoot=${workspaceRoot ?? "<unset>"})`,
    );

    api.registerGatewayMethod("clawhq.health", ({ respond }) => {
      respond(true, {
        plugin: PLUGIN_ID,
        version: PLUGIN_VERSION,
        workspaceRoot,
        surfaces: [
          "projects.list",
          "projects.get",
          "chats.list",
          "chats.history",
          "chats.append",
          "subprojects.tasks.toggle",
          "uploads.put",
          "memory.read",
          "memory.write",
          "events.subscribe",
        ].map((id) => ({ id, status: "planned" })),
      });
    });
  },
});
