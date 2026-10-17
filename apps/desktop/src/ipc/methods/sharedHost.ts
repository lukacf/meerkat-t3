import { DesktopSharedHostStateSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as DesktopSharedHost from "../../backend/DesktopSharedHost.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

export const getSharedHostState = makeIpcMethod({
  channel: IpcChannels.GET_SHARED_HOST_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopSharedHostStateSchema,
  handler: () => Effect.flatMap(DesktopSharedHost.DesktopSharedHost, (host) => host.state),
});
export const setSharedHostEnabled = makeIpcMethod({
  channel: IpcChannels.SET_SHARED_HOST_ENABLED_CHANNEL,
  payload: Schema.Boolean,
  result: DesktopSharedHostStateSchema,
  handler: (enabled) =>
    Effect.flatMap(DesktopSharedHost.DesktopSharedHost, (host) => host.setEnabled(enabled)),
});
