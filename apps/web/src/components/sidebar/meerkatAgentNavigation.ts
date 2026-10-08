/** Project agent routes carry their owning project without inventing a thread. */
export function projectAgentRouteScope(
  pathname: string,
  search: string,
): { environmentId: string; projectId: string } | null {
  const conversation = /^\/([^/]+)\/agents\/[^/]+\/?$/.exec(pathname);
  if (conversation) {
    const projectId = new URLSearchParams(search).get("project");
    return projectId ? { environmentId: decodeURIComponent(conversation[1]!), projectId } : null;
  }
  const setup = /^\/([^/]+)\/projects\/([^/]+)\/(?:agents\/(?:new|propose)|start)\/?$/.exec(
    pathname,
  );
  return setup
    ? { environmentId: decodeURIComponent(setup[1]!), projectId: decodeURIComponent(setup[2]!) }
    : null;
}
