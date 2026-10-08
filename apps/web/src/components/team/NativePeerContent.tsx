import type { ServerProviderSkill } from "@t3tools/contracts";
import ChatMarkdown from "../ChatMarkdown";
import { NativeAgentImages, imageRefsFromNative, type NativeMediaScope } from "./NativeAgentImages";
import type { NativePeerMessage } from "./nativePeerMessage.logic";

export function NativePeerContent({
  peer,
  scope,
  cwd,
  skills,
}: {
  peer: NativePeerMessage;
  scope: NativeMediaScope;
  cwd: string | undefined;
  skills: ReadonlyArray<ServerProviderSkill>;
}) {
  return (
    <div className="space-y-3 text-sm text-foreground">
      {peer.status ? (
        <p className="text-xs text-muted-foreground">{peer.status.replaceAll("_", " ")}</p>
      ) : null}
      {peer.text ? (
        <ChatMarkdown
          text={peer.text}
          cwd={cwd}
          environmentId={scope.environmentId}
          isStreaming={false}
          skills={skills}
          headingLevelOffset={3}
        />
      ) : null}
      <NativeAgentImages scope={scope} images={imageRefsFromNative(peer.content)} />
    </div>
  );
}
