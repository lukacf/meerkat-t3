import { useParams, useSearch } from "@tanstack/react-router";
import { KeyRoundIcon } from "lucide-react";
import { useState } from "react";
import { useProjects, useThreadShells } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { MeerkatProviderControls } from "./MeerkatProviderControls";

export function MeerkatConnectionsMenu() {
  const [open, setOpen] = useState(false);
  const projects = useProjects();
  const threads = useThreadShells();
  const { environments } = useEnvironments();
  const params = useParams({ strict: false });
  const search = useSearch({ strict: false });
  const [chosen, setChosen] = useState<string | null>(null);
  const routeProject =
    params.projectId ??
    search.project ??
    threads.find(
      (thread) => thread.id === params.threadId && thread.environmentId === params.environmentId,
    )?.projectId;
  const options = projects.filter((project) =>
    environments
      .find((environment) => environment.environmentId === project.environmentId)
      ?.serverConfig?.providers.some(
        (provider) => provider.driver === "meerkat" && provider.enabled,
      ),
  );
  const project =
    options.find((entry) => `${entry.environmentId}:${entry.id}` === chosen) ??
    options.find(
      (entry) => entry.id === routeProject && entry.environmentId === params.environmentId,
    ) ??
    options[0];
  if (!project) return null;
  const providers =
    environments
      .find((entry) => entry.environmentId === project.environmentId)
      ?.serverConfig?.providers.filter((entry) => entry.driver === "meerkat" && entry.enabled) ??
    [];
  return (
    <div className="border-t px-2 py-1">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger render={<Button variant="ghost" size="sm" />}>
          <KeyRoundIcon />
          Connections
        </PopoverTrigger>
        <PopoverPopup side="right" align="end" className="w-80">
          <PopoverTitle>Meerkat connections</PopoverTitle>
          <label className="block p-3 text-xs">
            Project
            <select
              aria-label="Connection project"
              className="mt-1 w-full rounded border bg-background p-2"
              value={`${project.environmentId}:${project.id}`}
              onChange={(event) => setChosen(event.target.value)}
            >
              {options.map((entry) => (
                <option
                  key={`${entry.environmentId}:${entry.id}`}
                  value={`${entry.environmentId}:${entry.id}`}
                >
                  {entry.title}
                </option>
              ))}
            </select>
          </label>
          {open &&
            providers.map((provider) => (
              <MeerkatProviderControls
                key={`${project.id}:${provider.instanceId}`}
                environmentId={project.environmentId}
                projectId={project.id}
                instanceId={provider.instanceId}
              />
            ))}
        </PopoverPopup>
      </Popover>
    </div>
  );
}
